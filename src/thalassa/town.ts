/**
 * The town: the quay and its curb, the harbour walls with their towers and
 * banners, the stairs up through the gates, the houses on the terrace and
 * the upper town, the market on the quay, the docks, the piles in the bay,
 * and the mole with its lighthouse.
 *
 * Everything static is batched into one mesh per material; the fruit in the
 * market is one instanced mesh. Colliders and walkable surfaces are
 * registered as things are placed, so what you see is what stops you.
 */
import * as THREE from "three";
import { makeRng } from "@/shared/proc/rng";
import {
  ACROPOLIS, GATES, MOLE, QUAY_Y, TERRACE_Y, bayNormal, heightAt, inTown, nearGate, offsetLine, quayWidth, sBay, shoreSamples, townMask,
} from "./map";
import { Batch, box, kit, roof, vary } from "./kit";
import type { BuildCtx, FrameCtx, Part } from "./types";

const STONE_WALL = "#e7cf9f";
const STONE_TOWER = "#e0c592";
const PLASTERS = ["#f3ead7", "#efe2c6", "#f6f0e2", "#ead7b5", "#e9d2a6"];
const STONES = ["#dcc497", "#d6ba8a", "#e3cfa4", "#cdb084"];
const ROOFS = ["#c8572e", "#d0663a", "#bd4f2a", "#d97a45", "#c25e34"];
const SHUTTERS = ["#3f74a8", "#4f8a5a", "#2f8f94", "#7a5b3a", "#a8452f"];
const AWNINGS = ["#e9862e", "#f2c641", "#3d7fb8", "#c9442f", "#efe6cf", "#d65a8a", "#4aa59a"];

export function createTown(ctx: BuildCtx): Part {
  const k = kit();
  const rng = makeRng("thalassa-town");
  const r = () => rng.next();
  const group = new THREE.Group();
  group.name = "town";

  const stone = new Batch(k.stone, "town-stone");
  const plaster = new Batch(k.plaster, "town-plaster");
  const roofs = new Batch(k.roof, "town-roofs");
  const wood = new Batch(k.wood, "town-wood");
  const paint = new Batch(k.paint, "town-paint");
  const cloth = new Batch(k.cloth, "town-cloth");
  const leaf = new Batch(k.leaf, "town-leaf");
  const { colliders, surfaces } = ctx;
  const lite = ctx.quality.tier !== "desktop";
  let fountainAt: THREE.Vector3 | null = null;
  let lighthouseAt: THREE.Vector3 | null = null;

  /* ------------------------------------------------------------------ *
   * The quay's edge
   * ------------------------------------------------------------------ */
  const shore = shoreSamples(1.5).filter((p) => townMask(p.x, p.z) > 0.6 && p.z < 97);
  for (let i = 0; i < shore.length - 1; i++) {
    const a = shore[i], b = shore[i + 1];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len > 4) continue;
    const rot = Math.atan2(b.z - a.z, b.x - a.x);
    const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
    // The face of the quay, a little proud of the shore line.
    stone.add(box(len + 0.05, 4.2, 1.4), vary("#cdb88f", r, 0.04), mx - a.nx * 0.2, QUAY_Y - 2.0, mz - a.nz * 0.2, -rot);
    // The coping: a lighter kerb along the top.
    stone.add(box(len + 0.05, 0.22, 0.7), "#efe2c4", mx - a.nx * 0.35, QUAY_Y + 0.08, mz - a.nz * 0.35, -rot);
    if (i % 6 === 0 && !nearGate(mx, mz, 6)) {
      const g = new THREE.CylinderGeometry(0.22, 0.28, 0.75, 8);
      stone.add(g, "#b9a37f", mx + a.nx * 0.5, QUAY_Y + 0.37, mz + a.nz * 0.5);
      colliders.circle(mx + a.nx * 0.5, mz + a.nz * 0.5, 0.28, QUAY_Y - 0.5, QUAY_Y + 0.8);
    }
  }

  /* ------------------------------------------------------------------ *
   * Walls, towers, gates
   * ------------------------------------------------------------------ */
  const runs = offsetLine((x, z) => quayWidth(x, z), (x, z) => townMask(x, z) > 0.6 && z < 97, 1.5);
  const inGateGap = (x: number, z: number) => {
    for (const g of GATES) {
      const dx = x - g.x, dz = z - g.z;
      const v = dx * g.nx + dz * g.nz, u = -dx * g.nz + dz * g.nx;
      if (Math.abs(u) < 3.4 && Math.abs(v - g.qw) < 6) return true;
    }
    return false;
  };
  const wallTopAt = (x: number, z: number) => {
    const [nx, nz] = bayNormal(x, z);
    const behind = heightAt(x + nx * 3, z + nz * 3);
    return Math.max(behind + 1.2, QUAY_Y + 3.9);
  };
  const towers: Array<{ x: number; z: number; rot: number; top: number }> = [];
  for (const run of runs) {
    let acc = 13;
    for (let i = 0; i < run.length - 1; i++) {
      const a = run[i], b = run[i + 1];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
      const rot = Math.atan2(b.z - a.z, b.x - a.x);
      acc += len;
      if (inGateGap(mx, mz)) { acc = 20; continue; }
      const top = wallTopAt(mx, mz);
      const base = QUAY_Y - 0.6;
      const [nx, nz] = bayNormal(mx, mz);
      const h = top - 1.1 - base;
      stone.add(box(len + 0.12, h, 2.5), vary(STONE_WALL, r, 0.03), mx, base + h / 2, mz, -rot);
      // A string course, and the parapet's merlons on the quay side.
      stone.add(box(len + 0.12, 0.25, 2.1), "#f1e3c3", mx, top - 1.1, mz, -rot);
      if (i % 2 === 0) stone.add(box(Math.min(len, 1.0), 1.1, 0.55), vary(STONE_WALL, r, 0.03), mx - nx * 0.68, top - 0.55, mz - nz * 0.68, -rot);
      else stone.add(box(len + 0.1, 0.45, 0.55), vary(STONE_WALL, r, 0.03), mx - nx * 0.68, top - 0.88, mz - nz * 0.68, -rot);
      colliders.segment(a.x, a.z, b.x, b.z, 2.5, base, top);
      if (acc > 27 && i > 2 && i < run.length - 3) {
        acc = 0;
        towers.push({ x: mx + nx * 0.6, z: mz + nz * 0.6, rot, top });
      }
    }
  }
  // Towers flank every gate.
  for (const g of GATES) {
    const gx = g.x + g.nx * g.qw, gz = g.z + g.nz * g.qw;
    const rot = Math.atan2(g.nx, -g.nz);
    const top = wallTopAt(gx, gz);
    for (const s of [-1, 1]) towers.push({ x: gx - g.nz * s * 6.4 + g.nx * 0.6, z: gz + g.nx * s * 6.4 + g.nz * 0.6, rot, top });
    // The lintel over the gate, high enough to walk under.
    const [nx, nz] = [g.nx, g.nz];
    stone.add(box(7.4, Math.max(1.4, top - TERRACE_Y - 3.6), 2.2), STONE_WALL, gx, (top + TERRACE_Y + 3.6) / 2, gz, -rot);
    stone.add(box(7.8, 0.3, 2.5), "#f1e3c3", gx, TERRACE_Y + 3.6, gz, -rot);
    // The stair itself: steps on the ramp, and cheek walls either side.
    const v0 = g.qw - 9, v1 = g.qw + 6;
    const steps = 24;
    for (let s = 0; s < steps; s++) {
      const t0 = s / steps, t1 = (s + 1) / steps;
      const v = v0 + (v1 - v0) * (t0 + t1) / 2;
      const y = QUAY_Y + (TERRACE_Y - QUAY_Y) * t1;
      const cx = g.x + nx * v, cz = g.z + nz * v;
      const below = Math.min(heightAt(cx, cz), QUAY_Y) - 0.3;
      stone.add(box(5.8, y - below, (v1 - v0) / steps + 0.02), s % 2 ? "#e9dab8" : "#e2d1ac", cx, (y + below) / 2, cz, -rot);
    }
    for (const s of [-1, 1]) {
      const ux = -nz * s * 3.25, uz = nx * s * 3.25;
      const segs = 6;
      for (let q = 0; q < segs; q++) {
        const ta = q / segs, tb = (q + 1) / segs;
        const va = v0 + (g.qw - 1 - v0) * ta, vb = v0 + (g.qw - 1 - v0) * tb;
        const ya = QUAY_Y + (TERRACE_Y - QUAY_Y) * ((va - v0) / (v1 - v0)), yb = QUAY_Y + (TERRACE_Y - QUAY_Y) * ((vb - v0) / (v1 - v0));
        const vm = (va + vb) / 2;
        const top2 = (ya + yb) / 2 + 1.0;
        const cx = g.x + nx * vm + ux, cz = g.z + nz * vm + uz;
        stone.add(box(0.7, top2 - QUAY_Y + 0.4, vb - va + 0.05), vary(STONE_WALL, r, 0.03), cx, (top2 + QUAY_Y - 0.4) / 2, cz, -rot);
        colliders.box(cx, cz, 0.7, vb - va, rot, QUAY_Y - 0.6, top2);
      }
    }
  }
  for (const t of towers) {
    const w = 6.2;
    const base = QUAY_Y - 0.6;
    const top = t.top + 4.2;
    stone.add(box(w, top - base, w), vary(STONE_TOWER, r, 0.04), t.x, (top + base) / 2, t.z, -t.rot);
    stone.add(box(w + 0.5, 0.35, w + 0.5), "#f1e3c3", t.x, top - 0.2, t.z, -t.rot);
    // Merlons round the top.
    const c = Math.cos(-t.rot), s = Math.sin(-t.rot);
    for (let m = 0; m < 4; m++) {
      for (const side of [-1, 1]) {
        const off = -w / 2 + 0.6 + m * ((w - 1.2) / 3);
        // Along the wall's direction, then across it.
        const lx1 = off, lz1 = side * (w / 2 - 0.3);
        stone.add(box(0.8, 1.0, 0.55), STONE_TOWER, t.x + lx1 * c + lz1 * s, top + 0.5, t.z - lx1 * s + lz1 * c, -t.rot);
        const lx2 = side * (w / 2 - 0.3), lz2 = off;
        stone.add(box(0.55, 1.0, 0.8), STONE_TOWER, t.x + lx2 * c + lz2 * s, top + 0.5, t.z - lx2 * s + lz2 * c, -t.rot);
      }
    }
    // Slits, and a banner on the face toward the water.
    const [nx, nz] = bayNormal(t.x, t.z);
    const fx = t.x - nx * (w / 2 + 0.06), fz = t.z - nz * (w / 2 + 0.06);
    for (const yy of [t.top - 2.5, top - 2.2]) paint.add(box(0.35, 1.3, 0.12), "#3a2a20", fx - nz * 1.6, yy, fz + nx * 1.6, -t.rot);
    const bh = Math.min(5, top - QUAY_Y - 3);
    const banner = new THREE.PlaneGeometry(1.7, bh, 1, 6);
    // A gentle billow: the banner bellies out a little at the bottom.
    const bp = banner.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < bp.count; i++) { const yv = bp.getY(i); bp.setZ(i, Math.sin(((bh / 2 - yv) / bh) * Math.PI) * 0.12); }
    const brot = Math.atan2(-nx, -nz);
    cloth.add(banner, "#b8321f", fx - nx * 0.08 + nz * 0.0, top - 1.6 - bh / 2, fz - nz * 0.08, brot);
    cloth.add(new THREE.PlaneGeometry(1.72, 0.22), "#f0c45a", fx - nx * 0.1, top - 1.6 - bh + 0.5, fz - nz * 0.1, brot);
    cloth.add(new THREE.CircleGeometry(0.42, 16), "#f0c45a", fx - nx * 0.1, top - 1.6 - bh * 0.35, fz - nz * 0.1, brot);
    colliders.box(t.x, t.z, w, w, -t.rot, base, top + 1);
  }

  /* ------------------------------------------------------------------ *
   * Houses
   * ------------------------------------------------------------------ */
  interface House { x: number; z: number; rot: number; w: number; d: number }
  const houses: House[] = [];
  const clear = (x: number, z: number, rad: number) => {
    for (const h of houses) if (Math.hypot(h.x - x, h.z - z) < rad + Math.max(h.w, h.d) * 0.55) return false;
    return true;
  };
  const avoid = (x: number, z: number) => {
    // Streets: one behind the wall, one through the middle of the terrace, and up from each gate.
    const dB = -sBay(x, z), qw = quayWidth(x, z);
    if (dB < qw + 5) return true;
    if (Math.abs(dB - (qw + 24)) < 2.6) return true;
    if (nearGate(x, z, 5)) return true;
    const acro = Math.hypot(x - ACROPOLIS.x, z - ACROPOLIS.z);
    if (acro < ACROPOLIS.r - 6) return true; // the upper town's square
    if (Math.abs(acro - (ACROPOLIS.r + 2)) < 2.4) return true;
    return false;
  };
  const buildHouse = (hs: House, opts: { farm?: boolean } = {}) => {
    const { x, z, rot, w, d } = hs;
    const c = Math.cos(rot), s = Math.sin(rot);
    let lo = Infinity, mid = heightAt(x, z);
    for (const [ax, az] of [[-w / 2, -d / 2], [w / 2, -d / 2], [-w / 2, d / 2], [w / 2, d / 2]]) {
      lo = Math.min(lo, heightAt(x + ax * c - az * s, z + ax * s + az * c));
    }
    const floor = Math.max(mid, lo + 0.2);
    const storeys = opts.farm ? 1 : r() < 0.55 ? 2 : r() < 0.6 ? 1 : 3;
    const top = floor + storeys * 3.1 + 0.4;
    const base = lo - 0.8;
    const usePlaster = r() < 0.62;
    const wallCol = usePlaster ? vary(rng.pick(PLASTERS), r, 0.04) : vary(rng.pick(STONES), r, 0.05);
    (usePlaster ? plaster : stone).add(box(w, top - base, d), wallCol, x, (top + base) / 2, z, -rot);
    colliders.box(x, z, w, d, rot, base, top);
    // A plinth of rougher stone where the ground falls away.
    if (floor - lo > 0.8) stone.add(box(w + 0.3, floor - base, d + 0.3), "#cdb48a", x, (floor + base) / 2, z, -rot);
    const flat = !opts.farm && r() < 0.22;
    if (flat) {
      // A roof terrace with a low parapet and pots.
      for (const [lx, lz, ww, dd] of [[0, d / 2 - 0.15, w, 0.3], [0, -d / 2 + 0.15, w, 0.3], [w / 2 - 0.15, 0, 0.3, d], [-w / 2 + 0.15, 0, 0.3, d]] as const) {
        (usePlaster ? plaster : stone).add(box(ww, 0.7, dd), wallCol, x + lx * c - lz * s, top + 0.35, z + lx * s + lz * c, -rot);
      }
      if (r() < 0.6) {
        // A pergola with a vine.
        const pw = w * 0.5, pd = d * 0.5;
        for (const [px, pz] of [[-pw / 2, -pd / 2], [pw / 2, -pd / 2], [-pw / 2, pd / 2], [pw / 2, pd / 2]]) wood.add(box(0.16, 2.2, 0.16, 1), "#8a6b4a", x + px * c - pz * s, top + 1.1, z + px * s + pz * c, -rot);
        wood.add(box(pw + 0.4, 0.14, pd + 0.4, 1), "#8a6b4a", x, top + 2.2, z, -rot);
        leaf.add(new THREE.IcosahedronGeometry(1, 1).scale(pw * 0.55, 0.35, pd * 0.55), "#5f9a3a", x, top + 2.4, z, -rot);
      }
      for (let p = 0; p < 2; p++) {
        const px = (r() - 0.5) * (w - 1.2), pz = (r() - 0.5) * (d - 1.2);
        paint.add(new THREE.CylinderGeometry(0.28, 0.2, 0.45, 8), "#c0643a", x + px * c - pz * s, top + 0.22, z + px * s + pz * c);
        leaf.add(new THREE.IcosahedronGeometry(0.42, 0), r() < 0.5 ? "#d6338a" : "#4f9a3a", x + px * c - pz * s, top + 0.75, z + px * s + pz * c);
      }
    } else {
      // Eaves, then a hipped roof of pan tiles.
      paint.add(box(w + 0.5, 0.22, d + 0.5), "#7a5a3c", x, top + 0.05, z, -rot);
      const rise = Math.min(w, d) * (0.26 + r() * 0.08);
      const along = w >= d;
      const rw = (along ? w : d) + 0.9, rd = (along ? d : w) + 0.9;
      roofs.add(roof(rw, rd, rise, rd / 2), vary(rng.pick(ROOFS), r, 0.06), x, top + 0.14, z, -rot + (along ? 0 : Math.PI / 2));
    }
    // Windows with shutters on the long faces, a door toward the water.
    if (!lite) {
      const shut = rng.pick(SHUTTERS);
      for (const side of [-1, 1]) {
        const faceZ = side * (d / 2 + 0.04);
        const n = Math.max(1, Math.floor(w / 2.6));
        for (let st = 0; st < storeys; st++) {
          for (let i = 0; i < n; i++) {
            if (r() < 0.2) continue;
            const lx = -w / 2 + (w / n) * (i + 0.5);
            const y = floor + 1.5 + st * 3.1;
            const wx = x + lx * c - faceZ * s, wz = z + lx * s + faceZ * c;
            paint.add(box(0.8, 1.15, 0.12), "#2c231c", wx, y, wz, -rot);
            for (const sh of [-1, 1]) {
              const sx = lx + sh * 0.62;
              paint.add(box(0.42, 1.15, 0.1), shut, x + sx * c - (faceZ + side * 0.03) * s, y, z + sx * s + (faceZ + side * 0.03) * c, -rot);
            }
          }
        }
      }
      // The door, on whichever long face is toward the bay.
      const [bnx, bnz] = bayNormal(x, z);
      const side = (-s * -bnx + c * -bnz) > 0 ? 1 : -1;
      const fz = side * (d / 2 + 0.05);
      const dx = (r() - 0.5) * (w - 2.4);
      paint.add(box(1.15, 2.15, 0.14), rng.pick(["#3b5f86", "#6b4a2e", "#2f6e6a", "#8a3a2a"]), x + dx * c - fz * s, floor + 1.07, z + dx * s + fz * c, -rot);
      stone.add(box(1.6, 0.25, 0.3), "#efe2c4", x + dx * c - fz * s, floor + 2.3, z + dx * s + fz * c, -rot);
    }
    // Bougainvillea up a corner.
    if (!opts.farm && r() < 0.32) {
      const cx = (r() < 0.5 ? -1 : 1) * (w / 2), cz = (r() < 0.5 ? -1 : 1) * (d / 2);
      const bx = x + cx * c - cz * s, bz = z + cx * s + cz * c;
      for (let b = 0; b < 5; b++) {
        const y = floor + 0.6 + b * (storeys * 3.1 / 5);
        const g = new THREE.IcosahedronGeometry(0.75 + r() * 0.35, 1);
        g.scale(1, 0.75, 1);
        leaf.add(g, b % 2 ? "#d6338a" : r() < 0.5 ? "#e85aa7" : "#3f8a3a", bx + (r() - 0.5) * 0.8, y, bz + (r() - 0.5) * 0.8);
      }
    }
    // Sometimes an annex at a different height, for the skyline.
    if (!opts.farm && r() < 0.38) {
      const aw = w * (0.45 + r() * 0.2), ad = d * (0.45 + r() * 0.25);
      const side = r() < 0.5 ? -1 : 1;
      const ax = side * (w / 2 + aw / 2 - 0.2);
      const axw = x + ax * c, azw = z + ax * s;
      const atop = floor + (storeys > 1 ? (storeys - 1) * 3.1 : 2.8) + 0.4;
      (usePlaster ? plaster : stone).add(box(aw, atop - base, ad), wallCol, axw, (atop + base) / 2, azw, -rot);
      colliders.box(axw, azw, aw, ad, rot, base, atop);
      paint.add(box(aw + 0.4, 0.2, ad + 0.4), "#7a5a3c", axw, atop + 0.05, azw, -rot);
      roofs.add(roof(ad + 0.8, aw + 0.8, Math.min(aw, ad) * 0.3, (aw + 0.8) / 2), vary(rng.pick(ROOFS), r, 0.06), axw, atop + 0.12, azw, -rot + Math.PI / 2);
    }
  };

  // The town on the terrace and the upper town.
  for (let i = 0; i < 9000 && houses.length < (lite ? 120 : 175); i++) {
    const x = -160 + r() * 210, z = -130 + r() * 200;
    if (!inTown(x, z) || avoid(x, z)) continue;
    const w = 6 + r() * 5, d = 5.5 + r() * 3.5;
    if (!clear(x, z, Math.max(w, d) * 0.55)) continue;
    // Face the water, or the upper town's square.
    const acro = Math.hypot(x - ACROPOLIS.x, z - ACROPOLIS.z);
    let rot: number;
    if (acro < ACROPOLIS.r + 14) rot = Math.atan2(z - ACROPOLIS.z, x - ACROPOLIS.x) + Math.PI / 2;
    else { const [nx, nz] = bayNormal(x, z); rot = Math.atan2(nz, nx) + Math.PI / 2; }
    rot += (r() - 0.5) * 0.12;
    const hs = { x, z, rot, w, d };
    houses.push(hs);
    buildHouse(hs);
  }
  // Warehouses along the south quay, backed against the sea wall.
  for (const p of shore) {
    if (p.z < 70 || p.x > 24 || p.x < -46) continue;
    const qw = quayWidth(p.x, p.z);
    const v = qw - 4.2;
    const x = p.x + p.nx * v, z = p.z + p.nz * v;
    const w = 7 + r() * 3, d = 5;
    if (!clear(x, z, 4.2) || nearGate(x, z, 6)) continue;
    const rot = Math.atan2(p.nz, p.nx) + Math.PI / 2;
    const hs = { x, z, rot, w, d };
    houses.push(hs);
    buildHouse(hs);
  }
  // Farmhouses out on the hills.
  const farmCap = houses.length + (lite ? 6 : 12);
  for (let i = 0; i < 400 && houses.length < farmCap; i++) {
    const x = -200 + r() * 240, z = -150 + r() * 250;
    if (townMask(x, z) < 0.9 || inTown(x, z)) continue;
    const h = heightAt(x, z);
    if (h < 4 || h > 60 || -sBay(x, z) < 40) continue;
    const w = 6 + r() * 3, d = 5 + r() * 2;
    if (!clear(x, z, 22)) continue;
    const hs = { x, z, rot: r() * Math.PI, w, d };
    houses.push(hs);
    buildHouse(hs, { farm: true });
  }

  /* ------------------------------------------------------------------ *
   * The market, a fountain, and the clutter of a working quay
   * ------------------------------------------------------------------ */
  const fruitGeo = new THREE.IcosahedronGeometry(0.11, 1);
  const fruitMat = new THREE.MeshStandardMaterial({ roughness: 0.6 });
  const fruit: Array<{ m: THREE.Matrix4; c: THREE.Color }> = [];
  const FRUITS = ["#f08a1c", "#f5d02c", "#c0262c", "#8bbf3a", "#7a2a6a", "#f05a28"];
  const amphora = (x: number, y: number, z: number, scale: number, col: string) => {
    const pts: THREE.Vector2[] = [];
    const prof = [[0.05, 0], [0.16, 0.08], [0.3, 0.35], [0.33, 0.55], [0.26, 0.8], [0.12, 0.95], [0.1, 1.15], [0.14, 1.2]];
    for (const [rr, yy] of prof) pts.push(new THREE.Vector2(rr * scale, yy * scale));
    paint.add(new THREE.LatheGeometry(pts, 10), col, x, y, z);
  };
  const stall = (x: number, z: number, rot: number) => {
    const c = Math.cos(rot), s = Math.sin(rot);
    const y = heightAt(x, z);
    const w = 3.4, d = 2.6;
    const L = (lx: number, lz: number): [number, number] => [x + lx * c - lz * s, z + lx * s + lz * c];
    for (const [px, pz, ph] of [[-w / 2, -d / 2, 2.5], [w / 2, -d / 2, 2.5], [-w / 2, d / 2, 2.1], [w / 2, d / 2, 2.1]]) {
      const [wx, wz] = L(px, pz);
      wood.add(box(0.12, ph, 0.12, 1), "#7b5a3a", wx, y + ph / 2, wz, -rot);
    }
    // The awning: sloped cloth, a valance at the front.
    const col = rng.pick(AWNINGS);
    const aw = new THREE.PlaneGeometry(w + 0.5, d + 0.6, 4, 2);
    aw.rotateX(-Math.PI / 2 + Math.atan2(0.4, d));
    const ap = aw.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < ap.count; i++) ap.setY(i, ap.getY(i) - Math.cos((ap.getX(i) / (w + 0.5)) * Math.PI) * 0.06);
    cloth.add(aw, col, x, y + 2.35, z, -rot);
    const [vx, vz] = L(0, d / 2 + 0.3);
    cloth.add(new THREE.PlaneGeometry(w + 0.5, 0.45), r() < 0.5 ? "#f6efdc" : col, vx, y + 1.95, vz, -rot);
    // The counter and what is on it.
    const [tx, tz] = L(0, d / 2 - 0.6);
    wood.add(box(w - 0.2, 0.9, 1.0, 1), "#8c6a45", tx, y + 0.45, tz, -rot);
    for (let b = 0; b < 3; b++) {
      const [bx, bz] = L(-w / 2 + 0.7 + b * ((w - 1.4) / 2), d / 2 - 0.6);
      paint.add(new THREE.CylinderGeometry(0.42, 0.32, 0.22, 12), "#b98a4e", bx, y + 1.0, bz);
      const fc = new THREE.Color(rng.pick(FRUITS));
      for (let f = 0; f < 14; f++) {
        const a = r() * Math.PI * 2, rr = Math.sqrt(r()) * 0.32;
        const m = new THREE.Matrix4().makeTranslation(bx + Math.cos(a) * rr, y + 1.16 + (0.32 - rr) * 0.45, bz + Math.sin(a) * rr);
        fruit.push({ m, c: fc.clone().offsetHSL(0, 0, (r() - 0.5) * 0.08) });
      }
    }
    // Amphorae and baskets behind.
    for (let a = 0; a < 3; a++) {
      const [ax, az] = L(-w / 2 + 0.6 + r() * (w - 1.2), -d / 2 + 0.5 + r() * 0.5);
      if (r() < 0.6) amphora(ax, y, az, 0.75 + r() * 0.25, rng.pick(["#c0643a", "#b5583a", "#d07a4a"]));
      else paint.add(new THREE.CylinderGeometry(0.3, 0.24, 0.45, 10), "#c9a060", ax, y + 0.22, az);
    }
    colliders.box(tx, tz, w - 0.2, 1.0, rot, y - 0.5, y + 1.0);
  };
  let stalls = 0;
  for (let i = 0; i < shore.length; i += 4) {
    const p = shore[i];
    const qw = quayWidth(p.x, p.z);
    if (qw < 15 && r() < 0.55) continue;
    const v = 5.5 + r() * Math.max(0.5, qw - 11);
    const x = p.x + p.nx * v, z = p.z + p.nz * v;
    if (nearGate(x, z, 7) || !clear(x, z, 2.6) || p.x > 40) continue;
    const rot = Math.atan2(-p.nz, -p.nx) - Math.PI / 2 + (r() - 0.5) * 0.3;
    houses.push({ x, z, rot, w: 3.6, d: 3 });
    stall(x, z, rot);
    stalls++;
  }

  // The fountain in the market square.
  {
    const p = shore.reduce((best, q) => (Math.abs(q.x - -14) + Math.abs(q.z - -15) < Math.abs(best.x - -14) + Math.abs(best.z - -15) ? q : best), shore[0]);
    const v = quayWidth(p.x, p.z) * 0.55;
    const fx = p.x + p.nx * v, fz = p.z + p.nz * v;
    const y = heightAt(fx, fz);
    stone.add(new THREE.CylinderGeometry(3.2, 3.4, 0.8, 28), "#e7d6b0", fx, y + 0.4, fz);
    paint.add(new THREE.CylinderGeometry(2.85, 2.85, 0.1, 28), "#3fb6c8", fx, y + 0.72, fz);
    stone.add(new THREE.CylinderGeometry(0.45, 0.6, 2.4, 14), "#efe2c4", fx, y + 1.6, fz);
    stone.add(new THREE.CylinderGeometry(1.2, 0.5, 0.35, 18), "#efe2c4", fx, y + 2.8, fz);
    colliders.circle(fx, fz, 3.4, y - 0.5, y + 0.9);
    houses.push({ x: fx, z: fz, rot: 0, w: 7, d: 7 });
    fountainAt = new THREE.Vector3(fx, y + 2.9, fz);
  }

  // Crates, amphorae, coils of rope and nets near the water.
  for (let i = 0; i < shore.length; i += 3) {
    if (r() < 0.55) continue;
    const p = shore[i];
    const v = 2 + r() * 2.5;
    const x = p.x + p.nx * v + (r() - 0.5), z = p.z + p.nz * v + (r() - 0.5);
    if (nearGate(x, z, 4) || !clear(x, z, 0.8)) continue;
    const y = heightAt(x, z);
    const kind = r();
    if (kind < 0.35) {
      const n = 1 + Math.floor(r() * 3);
      for (let b = 0; b < n; b++) wood.add(box(0.8, 0.7, 0.8, 1), "#a07a50", x + (b % 2) * 0.85, y + 0.35 + Math.floor(b / 2) * 0.7, z + (b % 2) * 0.1, r());
      colliders.circle(x + 0.4, z, 0.8, y - 0.5, y + 1);
    } else if (kind < 0.7) {
      for (let a = 0; a < 3 + Math.floor(r() * 4); a++) amphora(x + (r() - 0.5) * 1.2, y, z + (r() - 0.5) * 1.2, 0.7 + r() * 0.3, rng.pick(["#c0643a", "#b5583a", "#d07a4a", "#9c4a30"]));
    } else if (kind < 0.85) {
      paint.add(new THREE.TorusGeometry(0.32, 0.09, 6, 14).rotateX(Math.PI / 2), "#c8b07a", x, y + 0.09, z);
      paint.add(new THREE.TorusGeometry(0.22, 0.08, 6, 12).rotateX(Math.PI / 2), "#c8b07a", x, y + 0.24, z);
    } else {
      const net = new THREE.IcosahedronGeometry(0.7, 1);
      net.scale(1.3, 0.35, 1);
      paint.add(net, "#6b8a7a", x, y + 0.15, z);
    }
  }

  /* ------------------------------------------------------------------ *
   * Docks and piles
   * ------------------------------------------------------------------ */
  const DOCK_Y = 1.35;
  const docks: Array<{ x: number; z: number; nx: number; nz: number; len: number; w: number }> = [];
  const dockSeeds: Array<[number, number, number]> = [[-66, 46, 16], [-48, 72, 13], [-14, 80, 20], [12, 80, 14], [26, -12, 12], [-62, -2, 11]];
  for (const [sx, sz, len] of dockSeeds) {
    const p = shore.reduce((best, q) => (Math.hypot(q.x - sx, q.z - sz) < Math.hypot(best.x - sx, best.z - sz) ? q : best), shore[0]);
    docks.push({ x: p.x, z: p.z, nx: p.nx, nz: p.nz, len, w: 3.6 });
  }
  const postGeo = () => new THREE.CylinderGeometry(0.16, 0.19, 1, 7);
  for (const d of docks) {
    const rot = Math.atan2(d.nx, -d.nz);
    const cx = d.x - d.nx * (d.len / 2 - 0.5), cz = d.z - d.nz * (d.len / 2 - 0.5);
    wood.add(box(d.w, 0.3, d.len, 2), "#b89a72", cx, DOCK_Y - 0.15, cz, -rot);
    // Stringers and posts.
    for (let t = 0; t <= d.len; t += 3) {
      for (const sd of [-1, 1]) {
        const px = d.x - d.nx * t - d.nz * sd * (d.w / 2 - 0.1), pz = d.z - d.nz * t + d.nx * sd * (d.w / 2 - 0.1);
        const g = postGeo();
        const tall = t + 3 > d.len && r() < 0.8;
        const top = tall ? DOCK_Y + 0.9 : DOCK_Y - 0.25;
        g.scale(1, top + 6, 1);
        wood.add(g, "#5a4330", px, (top - 6) / 2, pz);
        if (tall) colliders.circle(px, pz, 0.2, DOCK_Y - 0.5, top);
      }
    }
    const nx = d.nx, nz = d.nz, len = d.len, w = d.w, x0 = d.x, z0 = d.z;
    surfaces.push((x, z) => {
      const dx = x - x0, dz = z - z0;
      const v = -(dx * nx + dz * nz), u = -dx * nz + dz * nx;
      return v > -1 && v < len && Math.abs(u) < w / 2 ? DOCK_Y : null;
    });
  }
  // Piles: rows of old mooring posts standing out of the middle of the bay.
  const pileGeo = new THREE.CylinderGeometry(0.17, 0.2, 1, 7);
  pileGeo.translate(0, 0.5, 0);
  const pileMat = new THREE.MeshStandardMaterial({ color: "#3d2e24", roughness: 0.9 });
  const piles: THREE.Matrix4[] = [];
  for (let row = 0; row < 7; row++) {
    const x0 = -40 + row * 9 + (r() - 0.5) * 4, z0 = 10 + r() * 30;
    const n = 3 + Math.floor(r() * 4);
    for (let p = 0; p < n; p++) {
      const x = x0 + (r() - 0.5) * 2.5, z = z0 + p * 4.2 + (r() - 0.5) * 1.5;
      if (sBay(x, z) < 8) continue;
      const floor = heightAt(x, z);
      const top = 0.8 + r() * 2.6;
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler((r() - 0.5) * 0.18, 0, (r() - 0.5) * 0.18));
      piles.push(new THREE.Matrix4().compose(new THREE.Vector3(x, floor, z), q, new THREE.Vector3(1, top - floor, 1)));
    }
  }
  const pileMesh = new THREE.InstancedMesh(pileGeo, pileMat, piles.length);
  piles.forEach((m, i) => pileMesh.setMatrixAt(i, m));
  pileMesh.castShadow = true;
  pileMesh.name = "piles";
  group.add(pileMesh);

  /* ------------------------------------------------------------------ *
   * The mole and the lighthouse
   * ------------------------------------------------------------------ */
  {
    const ax = MOLE.a.x, az = MOLE.a.z, bx = MOLE.b.x, bz = MOLE.b.z;
    const len = Math.hypot(bx - ax, bz - az);
    const rot = Math.atan2(bz - az, bx - ax);
    const mx = (ax + bx) / 2, mz = (az + bz) / 2;
    stone.add(box(len, MOLE.y + 6, MOLE.width), "#d2bd93", mx, (MOLE.y - 6) / 2, mz, -rot);
    stone.add(box(len, 0.2, MOLE.width + 0.3), "#efe2c4", mx, MOLE.y + 0.02, mz, -rot);
    // A low parapet on the sea side.
    const sx = Math.sin(rot), cz2 = Math.cos(rot);
    const px = mx - sx * (MOLE.width / 2 - 0.3), pz = mz + cz2 * (MOLE.width / 2 - 0.3);
    stone.add(box(len, 1.0, 0.6), "#dcc69a", px, MOLE.y + 0.5, pz, -rot);
    colliders.segment(ax - sx * (MOLE.width / 2 - 0.3), az + cz2 * (MOLE.width / 2 - 0.3), bx - sx * (MOLE.width / 2 - 0.3), bz + cz2 * (MOLE.width / 2 - 0.3), 0.6, MOLE.y - 0.5, MOLE.y + 1);
    const ux = (bx - ax) / len, uz = (bz - az) / len;
    surfaces.push((x, z) => {
      const dx = x - ax, dz = z - az;
      const t = dx * ux + dz * uz, u = -dx * uz + dz * ux;
      if (t < -1 || t > len + 4 || Math.abs(u) > MOLE.width / 2) return null;
      return MOLE.y;
    });
    // The lighthouse at the end: a round tower on a square base, a brazier on top.
    const lx = bx + ux * 2.5, lz = bz + uz * 2.5;
    stone.add(box(8, MOLE.y + 6, 8), "#d2bd93", lx, (MOLE.y - 6) / 2, lz, -rot);
    surfaces.push((x, z) => (Math.abs(x - lx) < 4 && Math.abs(z - lz) < 4 ? MOLE.y : null));
    const tower = new THREE.CylinderGeometry(2.4, 3.0, 13, 20);
    stone.add(tower, "#e6d2a6", lx, MOLE.y + 6.5, lz);
    stone.add(new THREE.CylinderGeometry(3.1, 3.1, 0.5, 20), "#f1e3c3", lx, MOLE.y + 13.2, lz);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      stone.add(new THREE.CylinderGeometry(0.18, 0.18, 2.4, 8), "#f1e3c3", lx + Math.cos(a) * 2.1, MOLE.y + 14.6, lz + Math.sin(a) * 2.1);
    }
    stone.add(new THREE.CylinderGeometry(2.8, 2.6, 0.4, 20), "#e6d2a6", lx, MOLE.y + 15.9, lz);
    paint.add(new THREE.CylinderGeometry(1.0, 0.6, 0.7, 14), "#4a3a2c", lx, MOLE.y + 14.0, lz);
    colliders.circle(lx, lz, 3.1, MOLE.y - 0.5, MOLE.y + 14);
    lighthouseAt = new THREE.Vector3(lx, MOLE.y + 14.5, lz);
    // A dark doorway.
    paint.add(box(1.3, 2.3, 0.2), "#2c231c", lx - ux * 2.6, MOLE.y + 1.15, lz - uz * 2.6, -rot + Math.PI / 2);
  }

  /* ---- build ---- */
  for (const b of [stone, plaster, roofs, wood, paint, leaf]) {
    const m = b.build();
    if (m) group.add(m);
  }
  const clothMesh = cloth.build({ shadows: true });
  if (clothMesh) group.add(clothMesh);
  const fruitMesh = new THREE.InstancedMesh(fruitGeo, fruitMat, Math.max(1, fruit.length));
  fruit.forEach((f, i) => { fruitMesh.setMatrixAt(i, f.m); fruitMesh.setColorAt(i, f.c); });
  fruitMesh.count = fruit.length;
  fruitMesh.name = "fruit";
  group.add(fruitMesh);

  /* ---- what moves: the fountain's jet and the lighthouse fire ---- */
  const jet = new THREE.Mesh(
    new THREE.CylinderGeometry(0.05, 0.22, 1.6, 10, 1, true),
    new THREE.MeshStandardMaterial({ color: "#bfefff", transparent: true, opacity: 0.55, roughness: 0.1, emissive: "#6fd6ff", emissiveIntensity: 0.2, depthWrite: false }),
  );
  if (fountainAt) { jet.position.copy(fountainAt).add(new THREE.Vector3(0, 0.8, 0)); group.add(jet); }
  const fireMat = new THREE.MeshBasicMaterial({ color: "#ffb347", transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending });
  const flames: THREE.Mesh[] = [];
  if (lighthouseAt) {
    for (let i = 0; i < 4; i++) {
      const f = new THREE.Mesh(new THREE.ConeGeometry(0.55 - i * 0.08, 1.6 + i * 0.3, 8, 1, true), fireMat);
      f.position.copy(lighthouseAt).add(new THREE.Vector3((i - 1.5) * 0.18, 0.9, (i % 2 - 0.5) * 0.25));
      group.add(f);
      flames.push(f);
    }
  }

  return {
    group,
    update(_dt: number, time: number, _ctx: FrameCtx) {
      jet.scale.y = 0.9 + Math.sin(time * 9) * 0.06;
      flames.forEach((f, i) => {
        f.scale.set(1 + Math.sin(time * 13 + i) * 0.12, 0.8 + Math.abs(Math.sin(time * 9 + i * 1.7)) * 0.5, 1 + Math.cos(time * 11 + i) * 0.12);
        f.rotation.y = time * (1 + i * 0.3);
      });
    },
    dispose() {
      group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) m.geometry.dispose();
      });
      fruitMat.dispose();
      pileMat.dispose();
      fireMat.dispose();
      (jet.material as THREE.Material).dispose();
      k.dispose();
    },
  };
}
