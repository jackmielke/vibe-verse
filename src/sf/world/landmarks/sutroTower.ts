/**
 * Sutro Tower — 297 m of red-and-white lattice on the ridge between Twin Peaks
 * and Mount Sutro, standing on ground that is already 250 m up.
 *
 * It is the single most important navigation anchor in the game. From almost
 * anywhere in San Francisco you can see it, and if you can see it you know
 * which way is southwest. So it has one hard requirement the other landmarks do
 * not have: **it must never disappear**. Its far LOD is built at load and is
 * exempt from distance culling, and it deliberately keeps a fatter silhouette
 * at range than the geometry strictly justifies, because a true-width lattice
 * at 8 km is a sub-pixel wire that vanishes into the fog.
 *
 * Shape: three legs on a triangular base, converging as they rise, tied by
 * lattice bracing, with two enormous antenna platforms near the top and a
 * smaller one lower down. The aviation banding is 1:1 red and white in equal
 * segments, which is what makes it read as *striped* rather than as pink.
 */
import * as THREE from "three";
import * as M from "./materials";
import { box, strut, taperBoxCyl, xform } from "./kit";
import { type LandmarkCtx, type LandmarkModule } from "./types";
import type { LandmarkDef } from "../../geo/sfGeo";

const HEIGHT = 297;
const BASE_R = 27; // leg centre to tower axis at the ground
const TOP_R = 5.4;
const MAST = 34;
const BANDS = 7; // odd count, so the tower starts and ends red

/** Leg radius from the axis at height fraction t. */
function legR(t: number): number {
  // The legs are not straight: they close quickly through the lower third and
  // then run nearly parallel. That kink is very visible in profile.
  return TOP_R + (BASE_R - TOP_R) * Math.pow(1 - t, 1.7);
}

function build(ctx: LandmarkCtx): void {
  const { batch, detail } = ctx;
  const g = ctx.originY;
  const red = M.aviationRed();
  const white = M.paintedWhite();
  const dark = M.darkSteel();

  /* ---------------- footings ---------------- */
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 - Math.PI / 2;
    const px = Math.cos(a) * BASE_R;
    const pz = Math.sin(a) * BASE_R;
    const gy = ctx.ground(px, pz);
    batch.add(M.concrete(0xc8c2b4), box(11, 6, 11), xform(px, gy + 1.5, pz, -a));
    ctx.collide.box(px, gy + 3, pz, 5.5, 3, 5.5, -a, { walkable: true });
  }

  /* ---------------- legs ---------------- */
  // Each leg is a stack of tapered tubes; the band a segment falls in decides
  // whether it is painted red or white.
  const segs = detail ? 42 : 14;
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 - Math.PI / 2;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    for (let s = 0; s < segs; s++) {
      const t0 = s / segs;
      const t1 = (s + 1) / segs;
      const band = Math.floor(((t0 + t1) / 2) * BANDS);
      const mat = band % 2 === 0 ? red : white;
      const r0 = legR(t0);
      const r1 = legR(t1);
      const y0 = g + HEIGHT * t0;
      const y1 = g + HEIGHT * t1;
      const w0 = 2.6 - 1.5 * t0;
      const w1 = 2.6 - 1.5 * t1;
      // A leaning member: lofted between two offset rings via a tapered drum
      // placed and rotated to match the lean.
      const dx = (r1 - r0) * cos;
      const dz = (r1 - r0) * sin;
      const dy = y1 - y0;
      const len = Math.hypot(Math.hypot(dx, dz), dy);
      const lean = Math.atan2(Math.hypot(dx, dz), dy);
      const geo = taperBoxCyl(w0 / 2, w1 / 2, len, detail ? 8 : 5);
      LEAN.makeRotationZ(-lean);
      batch.add(
        mat,
        geo,
        xform(cos * r0, y0, sin * r0, Math.atan2(-dz, dx) + Math.PI / 2).multiply(LEAN),
      );
    }
    ctx.collide.box(
      cos * legR(0.5),
      g + HEIGHT / 2,
      sin * legR(0.5),
      2.5,
      HEIGHT / 2,
      2.5,
      0,
      { walkable: false },
    );
  }

  /* ---------------- lattice bracing ---------------- */
  const braceLevels = detail ? 34 : 10;
  const horiz = batch.instances(dark, box(1, 1, 1));
  const diag = batch.instances(dark, box(1, 1, 1));
  for (let lv = 1; lv <= braceLevels; lv++) {
    const t0 = (lv - 1) / braceLevels;
    const t1 = lv / braceLevels;
    for (let i = 0; i < 3; i++) {
      const a0 = (i / 3) * Math.PI * 2 - Math.PI / 2;
      const a1 = (((i + 1) % 3) / 3) * Math.PI * 2 - Math.PI / 2;
      const p0 = [Math.cos(a0) * legR(t1), g + HEIGHT * t1, Math.sin(a0) * legR(t1)];
      const p1 = [Math.cos(a1) * legR(t1), g + HEIGHT * t1, Math.sin(a1) * legR(t1)];
      const q0 = [Math.cos(a0) * legR(t0), g + HEIGHT * t0, Math.sin(a0) * legR(t0)];
      // Horizontal ring member.
      place(horiz, p0, p1, 0.42);
      // Diagonal from the lower node of one leg to the upper node of the next.
      place(diag, q0, p1, 0.34);
    }
  }

  /* ---------------- antenna platforms ---------------- */
  // Two great crossarm decks near the top and a service deck lower down. These
  // are what make the silhouette read as Sutro and not as a pylon.
  const decks: [number, number, number][] = [
    [0.28, 20, 2.2],
    [0.62, 30, 3.0],
    [0.79, 27, 2.6],
  ];
  const ant = batch.instances(dark, box(0.28, 1, 0.28));
  const bar = batch.instances(dark, box(2.6, 0.16, 0.16));
  for (const [t, reach, thick] of decks) {
    const y = g + HEIGHT * t;
    const r = legR(t);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 - Math.PI / 2 + Math.PI / 3;
      batch.add(white, box(reach, thick, 4.4), xform(Math.cos(a) * (r + reach / 2 - 2), y, Math.sin(a) * (r + reach / 2 - 2), -a));
      if (!detail) continue;
      // Antennas: dipole bays hanging off the arms.
      for (let k = 0; k < 8; k++) {
        const d = r + 2 + (reach - 6) * (k / 8);
        ant.atPos(Math.cos(a) * d, y - 4.4, Math.sin(a) * d, 0, 0, 0, 1, 8.5, 1);
      }
      for (let k = 0; k < 12; k++) {
        const d = r + 2 + (reach - 6) * (k / 12);
        bar.atPos(Math.cos(a) * d, y - 1 - k * 0.6, Math.sin(a) * d, -a);
      }
    }
    // Deck ring tying the three arms together.
    batch.add(white, box(r * 2 + 3, thick * 0.8, r * 2 + 3), xform(0, y, 0, Math.PI / 4));
    ctx.collide.box(0, y, 0, r + 1.5, thick, r + 1.5, 0, { walkable: true });
  }

  /* ---------------- the mast ---------------- */
  for (let s = 0; s < (detail ? 8 : 3); s++) {
    const n = detail ? 8 : 3;
    const t0 = s / n;
    const t1 = (s + 1) / n;
    const mat = s % 2 === 0 ? white : red;
    batch.add(
      mat,
      taperBoxCyl(1.6 - t0 * 1.0, 1.6 - t1 * 1.0, (MAST / n) * 1.0, detail ? 8 : 5),
      xform(0, g + HEIGHT + MAST * t0, 0),
    );
  }
  const beaconMat = M.emitter(0xff2418, 8);
  const beaconGeo = new THREE.SphereGeometry(1.1, 10, 8);
  batch.add(beaconMat, beaconGeo, xform(0, g + HEIGHT + MAST + 1.4, 0));
  // Mid-height obstruction lights.
  for (const t of [0.35, 0.62, 0.86]) {
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 - Math.PI / 2;
      batch.add(beaconMat, beaconGeo, xform(Math.cos(a) * legR(t) * 1.05, g + HEIGHT * t, Math.sin(a) * legR(t) * 1.05, 0, 0, 0, 0.5));
    }
  }
  beaconGeo.dispose();
  ctx.onFrame((t) => {
    // Two flashes then a pause — the standard medium-intensity red rhythm.
    const c = t % 3;
    beaconMat.emissiveIntensity = c < 0.22 || (c > 0.5 && c < 0.72) ? 12 : 1.6;
  });

  /* ---------------- the transmitter building ---------------- */
  if (detail) {
    const bx = -BASE_R - 22;
    const bg = ctx.ground(bx, 0);
    batch.add(M.concrete(0xbdb7aa), box(34, 8, 20), xform(bx, bg + 4, 0));
    batch.add(M.flatRoof(), box(35, 0.5, 21), xform(bx, bg + 8.2, 0));
    ctx.collide.box(bx, bg + 4, 0, 17, 4, 10, 0, { walkable: false });
    const dish = new THREE.SphereGeometry(2.4, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2.6);
    for (let i = 0; i < 3; i++) {
      batch.add(M.galvanised(), dish, xform(bx - 12 + i * 12, bg + 10, 8, 0, -0.7, 0));
    }
    dish.dispose();
    // Chainlink perimeter — nobody gets to climb this thing.
    const fence = batch.instances(M.chainlink(), box(6, 3, 0.05));
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * Math.PI * 2;
      const r = BASE_R + 16;
      fence.atPos(Math.cos(a) * r, ctx.ground(Math.cos(a) * r, Math.sin(a) * r) + 1.5, Math.sin(a) * r, -a);
    }
  }
}

const LEAN = new THREE.Matrix4();

/** Place a unit box (aligned to +X) as a bar between two points. */
function place(
  bucket: { at: (m: THREE.Matrix4) => unknown },
  a: number[],
  b: number[],
  w = 1,
): void {
  bucket.at(strut(a[0], a[1], a[2], b[0], b[1], b[2], w, w));
}

export const sutroTower: LandmarkModule = {
  yaw: (_def: LandmarkDef) => 0.42,
  build,
  nearRange: (def) => Math.max(1800, def.radius * 20),
  anchor: true,
};
