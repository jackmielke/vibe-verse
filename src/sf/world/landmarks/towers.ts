/**
 * The three downtown blocks that are not the Transamerica or Salesforce, and
 * which each have exactly one memorable idea:
 *
 *   555 California    Dark carnelian granite and a facade made entirely of
 *                     projecting bay windows — a sawtooth in plan. It is the
 *                     Bank of America building; it is the villain's tower in
 *                     "A View to a Kill"; it is the darkest object on the
 *                     skyline and it reads as a slab of iron ore.
 *   Millennium Tower  Blue-green glass, a faceted crown, and a four-degree-of-
 *                     arc problem: it has settled 45 cm and leans measurably
 *                     to the northwest. Modelling it plumb would be historical
 *                     revisionism.
 *   SFMOMA            Botta's striped oculus rising out of a stepped red-brick
 *                     mass, with Snøhetta's white rippled slab standing behind
 *                     it like a wave that got lost.
 */
import * as THREE from "three";
import * as M from "./materials";
import { box, loft, roundedRectRing, taperBox, xform } from "./kit";
import { streetYaw, type LandmarkCtx, type LandmarkModule } from "./types";
import type { LandmarkDef } from "../../geo/sfGeo";

/* ================================================================== *
 * 555 California
 * ================================================================== */

const CAL_H = 237;
const CAL_HX = 33;
const CAL_HZ = 23;

/**
 * A plan ring built from projecting bay windows.
 *
 * Every side is divided into modules; each module steps out, runs flat, and
 * steps back. Chamfered corners tie the four runs together. The result is a
 * plan with 100-odd vertices whose silhouette catches raking light on every
 * facet — which is the entire reason the real building looks the way it does
 * at sunset and a plain box does not.
 */
function bayRing(
  hx: number,
  hz: number,
  y: number,
  modulesX: number,
  modulesZ: number,
  proj: number,
  chamfer: number,
): Float32Array {
  const pts: number[] = [];
  const run = (
    x0: number,
    z0: number,
    x1: number,
    z1: number,
    n: number,
    nx: number,
    nz: number,
  ) => {
    for (let i = 0; i < n; i++) {
      const a = i / n;
      const b = (i + 1) / n;
      const seq = [a, a + (b - a) * 0.26, a + (b - a) * 0.74, b];
      const outs = [0, proj, proj, 0];
      for (let k = 0; k < 4; k++) {
        const t = seq[k];
        pts.push(x0 + (x1 - x0) * t + nx * outs[k], y, z0 + (z1 - z0) * t + nz * outs[k]);
      }
    }
  };
  const cx = hx - chamfer;
  const cz = hz - chamfer;
  run(-cx, -hz, cx, -hz, modulesX, 0, -1);
  pts.push(cx, y, -hz, hx, y, -cz);
  run(hx, -cz, hx, cz, modulesZ, 1, 0);
  pts.push(hx, y, cz, cx, y, hz);
  run(cx, hz, -cx, hz, modulesX, 0, 1);
  pts.push(-cx, y, hz, -hx, y, cz);
  run(-hx, cz, -hx, -cz, modulesZ, -1, 0);
  pts.push(-hx, y, -cz, -cx, y, -hz);
  return new Float32Array(pts);
}

function buildFiveFiveFive(ctx: LandmarkCtx): void {
  const { batch, detail } = ctx;
  const g = ctx.originY;
  const granite = M.carnelianGranite();
  const glass = M.curtainGlass(0x6f7c86);
  const mx = detail ? 7 : 3;
  const mz = detail ? 5 : 2;

  // Plaza and the sunken forecourt with Masayuki Nagare's black granite
  // sculpture — locals call it the Banker's Heart, and it is a landmark of its
  // own at street level.
  batch.add(M.paving(0xb9b2a6), box(CAL_HX * 2 + 22, 0.6, CAL_HZ * 2 + 30), xform(0, g + 0.3, 0));
  if (detail) {
    batch.add(
      M.civicStone(0x2c2a29),
      taperBox(9, 5, 6.5, 3.4, 6.5),
      xform(0, g + 0.6, CAL_HZ + 11),
    );
  }

  const bands = detail ? 52 : 8;
  const rings: Float32Array[] = [];
  for (let i = 0; i <= bands; i++) {
    const y = g + 4 + ((CAL_H - 4) * i) / bands;
    // Two setbacks near the top, the second one only on the corners.
    const t = i / bands;
    const shrink = t > 0.93 ? 2.2 : t > 0.87 ? 1.1 : 0;
    rings.push(bayRing(CAL_HX - shrink, CAL_HZ - shrink, y, mx, mz, detail ? 1.35 : 0, 5.5));
  }
  batch.add(granite, loft(rings, false, true));

  // Glazing sits inside the bays: a slightly smaller ring, dark, offset in.
  if (detail) {
    const gr: Float32Array[] = [];
    for (let i = 0; i <= bands; i++) {
      const y = g + 4 + ((CAL_H - 4) * i) / bands;
      const t = i / bands;
      const shrink = (t > 0.93 ? 2.2 : t > 0.87 ? 1.1 : 0) + 0.32;
      gr.push(bayRing(CAL_HX - shrink, CAL_HZ - shrink, y, mx, mz, 1.35, 5.5));
    }
    batch.add(glass, loft(gr, false, false));
  }

  // Base colonnade: the tower meets the plaza on heavy granite piers.
  batch.add(granite, box(CAL_HX * 2 + 3, 4.6, CAL_HZ * 2 + 3), xform(0, g + 2.3, 0));
  // Crown mechanical box and mast.
  batch.add(granite, box(CAL_HX * 1.1, 6, CAL_HZ * 1.1), xform(0, g + CAL_H + 3, 0));
  batch.add(M.paintedColour(0xb8babd, 1), box(0.6, 14, 0.6), xform(0, g + CAL_H + 13, 0));
  const beaconGeo = new THREE.SphereGeometry(0.6, 8, 6);
  batch.add(M.emitter(0xff3020, 5), beaconGeo, xform(0, g + CAL_H + 20.5, 0));
  beaconGeo.dispose();

  for (let i = 0; i < 8; i++) {
    const y0 = g + 4 + ((CAL_H - 4) * i) / 8;
    const y1 = g + 4 + ((CAL_H - 4) * (i + 1)) / 8;
    ctx.collide.box(0, (y0 + y1) / 2, 0, CAL_HX, (y1 - y0) / 2, CAL_HZ, 0, { walkable: false });
  }
  ctx.collide.box(0, g + CAL_H + 0.5, 0, CAL_HX, 1, CAL_HZ, 0, { walkable: true });
}

export const fiveFiveFiveCalifornia: LandmarkModule = {
  yaw: (def: LandmarkDef) => streetYaw(def.x, def.z, 0),
  build: buildFiveFiveFive,
  nearRange: (def) => Math.max(1100, def.radius * 16),
};

/* ================================================================== *
 * Millennium Tower
 * ================================================================== */

const MILL_H = 197;
/** 45 cm of settlement over 197 m, leaning northwest. Yes, really. */
const MILL_TILT = 0.0074;

function buildMillennium(ctx: LandmarkCtx): void {
  const { batch, detail } = ctx;
  const g = ctx.originY;
  const glass = M.curtainGlass(0x8fb0b4);
  const fin = M.paintedColour(0x9aa4a8, 1.2);
  const seg = detail ? 40 : 16;

  const halfAt = (t: number) => 17.5 - 3.4 * t;
  const bands = detail ? 58 : 8;
  const rings: Float32Array[] = [];
  for (let i = 0; i <= bands; i++) {
    const t = i / bands;
    const y = 4 + (MILL_H - 4) * t;
    const h = halfAt(t);
    const r = roundedRectRing(h * 2, h * 1.72, 6.4, g + y, seg);
    // The lean: every ring above ground is displaced by y·tanθ. Structurally
    // this is exactly what differential settlement does, and it means the
    // silhouette against the Salesforce Tower behind it is visibly off-plumb.
    const dx = y * MILL_TILT * 0.82;
    const dz = -y * MILL_TILT * 0.57;
    for (let k = 0; k < seg; k++) {
      r[k * 3] += dx;
      r[k * 3 + 2] += dz;
    }
    rings.push(r);
  }
  batch.add(glass, loft(rings, false, true));

  // Vertical fins on the two long faces.
  if (detail) {
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * Math.PI * 2;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      const lo = new Float32Array(12);
      const hi = new Float32Array(12);
      for (let k = 0; k < 4; k++) {
        const du = k === 1 || k === 2 ? 0.28 : -0.28;
        const dn = k >= 2 ? 0.3 : 0;
        const r0 = halfAt(0) * (k >= 2 ? 1.0 : 1.0);
        lo[k * 3] = cos * (r0 + dn) - sin * du;
        lo[k * 3 + 1] = g + 5;
        lo[k * 3 + 2] = sin * (r0 * 0.86 + dn) + cos * du;
        const r1 = halfAt(1);
        hi[k * 3] = cos * (r1 + dn) - sin * du + MILL_H * MILL_TILT * 0.82;
        hi[k * 3 + 1] = g + MILL_H;
        hi[k * 3 + 2] = sin * (r1 * 0.86 + dn) + cos * du - MILL_H * MILL_TILT * 0.57;
      }
      batch.add(fin, loft([lo, hi], true, true));
    }
  }

  // Faceted crown: the top three floors are cut back on a slope.
  const topH = halfAt(1);
  const capA = roundedRectRing(topH * 2, topH * 1.72, 6.4, g + MILL_H, seg);
  const capB = roundedRectRing(topH * 1.3, topH * 1.05, 4.4, g + MILL_H + 9, seg);
  for (let k = 0; k < seg; k++) {
    capA[k * 3] += MILL_H * MILL_TILT * 0.82;
    capA[k * 3 + 2] -= MILL_H * MILL_TILT * 0.57;
    capB[k * 3] += (MILL_H + 9) * MILL_TILT * 0.82;
    capB[k * 3 + 2] -= (MILL_H + 9) * MILL_TILT * 0.57;
  }
  batch.add(fin, loft([capA, capB], false, true));

  // Podium.
  batch.add(M.civicStone(0xcfc9bd), box(44, 5, 38), xform(0, g + 2.5, 0));
  ctx.collide.box(0, g + MILL_H / 2, 0, 18, MILL_H / 2, 15.5, 0, { walkable: false });
  ctx.collide.box(0, g + MILL_H, 0, 16, 1, 13, 0, { walkable: true });
}

export const millenniumTower: LandmarkModule = {
  yaw: (def: LandmarkDef) => streetYaw(def.x, def.z, 0),
  build: buildMillennium,
  nearRange: (def) => Math.max(900, def.radius * 18),
};

/* ================================================================== *
 * SFMOMA
 * ================================================================== */

function buildSfmoma(ctx: LandmarkCtx): void {
  const { batch, detail } = ctx;
  const g = ctx.originY;
  const brickDark = M.brick(0xb4705c);
  const brickLight = M.brick(0xd0907a);
  const white = M.paintedColour(0xe9e6df, 2.2);
  const glass = M.curtainGlass(0x7f909c);

  /* ---- Botta's stepped brick mass, symmetric about the oculus ---- */
  const steps: [number, number, number][] = [
    [58, 20, 26], // width, height, depth
    [44, 30, 22],
    [30, 40, 18],
  ];
  for (let i = 0; i < steps.length; i++) {
    const [w, h, d] = steps[i];
    batch.add(i % 2 === 0 ? brickDark : brickLight, box(w, h, d), xform(0, g + h / 2, -2 - i * 2));
  }
  ctx.collide.box(0, g + 20, 0, 29, 20, 13, 0, { walkable: false });
  ctx.collide.box(0, g + 40.5, -6, 15, 0.6, 9, 0, { walkable: true });

  // Deep-set square windows in the brick — Botta's signature punched openings.
  if (detail) {
    const win = batch.instances(glass, box(2.6, 2.6, 0.5));
    for (let r = 0; r < 4; r++) {
      for (let c = -4; c <= 4; c++) {
        if (Math.abs(c) < 2) continue;
        win.atPos(c * 5.4, g + 5 + r * 5.4, 11.1);
      }
    }
    const reveal = batch.instances(brickLight, box(3.4, 3.4, 1.2));
    for (let r = 0; r < 4; r++) {
      for (let c = -4; c <= 4; c++) {
        if (Math.abs(c) < 2) continue;
        reveal.atPos(c * 5.4, g + 5 + r * 5.4, 10.6);
      }
    }
  }

  /* ---- the oculus: a striped cylinder sliced on the diagonal ---- */
  const R = 9.2;
  const seg = detail ? 40 : 16;
  const stripes = detail ? 22 : 8;
  const baseY = 8;
  const topY = 47;
  for (let i = 0; i < stripes; i++) {
    const y0 = baseY + ((topY - baseY) * i) / stripes;
    const y1 = baseY + ((topY - baseY) * (i + 1)) / stripes;
    const mat = i % 2 === 0 ? M.civicStone(0x2b2a29) : M.civicStone(0xece7dc);
    const a = new Float32Array(seg * 3);
    const b = new Float32Array(seg * 3);
    for (let k = 0; k < seg; k++) {
      const th = (k / seg) * Math.PI * 2;
      const cx = Math.cos(th) * R;
      const cz = Math.sin(th) * R;
      // The famous cut: the top of the drum is sliced on a plane, so the
      // stripes run out at different heights around the circumference.
      const slice = cz * 0.62;
      a[k * 3] = cx;
      a[k * 3 + 1] = g + Math.min(y0, topY + slice);
      a[k * 3 + 2] = cz;
      b[k * 3] = cx;
      b[k * 3 + 1] = g + Math.min(y1, topY + slice);
      b[k * 3 + 2] = cz;
    }
    batch.add(mat, loft([a, b], false, false));
  }
  // The glazed skylight closing the sliced top.
  const rim = new Float32Array(seg * 3);
  const rim2 = new Float32Array(seg * 3);
  for (let k = 0; k < seg; k++) {
    const th = (k / seg) * Math.PI * 2;
    const cx = Math.cos(th) * R;
    const cz = Math.sin(th) * R;
    rim[k * 3] = cx;
    rim[k * 3 + 1] = g + topY + cz * 0.62;
    rim[k * 3 + 2] = cz;
    rim2[k * 3] = cx * 0.05;
    rim2[k * 3 + 1] = g + topY + 1.4;
    rim2[k * 3 + 2] = cz * 0.05;
  }
  batch.add(glass, loft([rim, rim2], false, true));
  ctx.collide.box(0, g + (baseY + topY) / 2, 0, R, (topY - baseY) / 2, R, 0, { walkable: false });

  /* ---- Snohetta expansion: white, rippled, ten storeys ---- */
  const exW = 74;
  const exH = 58;
  const exZ = -34;
  const ripples = detail ? 46 : 10;
  const front: Float32Array[] = [];
  for (const y of [0, exH]) {
    const pts: number[] = [];
    for (let i = 0; i <= ripples; i++) {
      const t = i / ripples;
      const x = -exW / 2 + exW * t;
      // A slow horizontal swell with a faster ripple riding on it — the panels
      // are fibre-reinforced polymer, cast from a single undulating mould.
      const out = Math.sin(t * Math.PI * 3.2) * 1.5 + Math.sin(t * Math.PI * 9) * 0.55;
      pts.push(x, g + y, exZ + 13 + out);
    }
    for (let i = ripples; i >= 0; i--) {
      const t = i / ripples;
      pts.push(-exW / 2 + exW * t, g + y, exZ - 13);
    }
    front.push(new Float32Array(pts));
  }
  batch.add(white, loft(front, false, true));
  ctx.collide.box(0, g + exH / 2, exZ, exW / 2, exH / 2, 13, 0, { walkable: false });
  ctx.collide.box(0, g + exH, exZ, exW / 2, 0.6, 13, 0, { walkable: true });

  // A slot of glazing at the top of the expansion, and the roof terrace rail.
  batch.add(glass, box(exW - 6, 3.4, 1), xform(0, g + exH - 4, exZ + 13.4));
  if (detail) {
    const rail = batch.instances(M.darkSteel(), box(0.08, 1.1, 0.08));
    for (let i = 0; i <= 30; i++) {
      rail.atPos(-exW / 2 + (exW * i) / 30, g + exH + 0.55, exZ + 12.6);
    }
  }
}

export const sfmoma: LandmarkModule = {
  yaw: (def: LandmarkDef) => streetYaw(def.x, def.z, Math.PI / 2),
  build: buildSfmoma,
  nearRange: (def) => Math.max(600, def.radius * 12),
};
