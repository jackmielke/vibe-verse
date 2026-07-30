/**
 * The Transamerica Pyramid.
 *
 * The building San Francisco is drawn as. Four numbers do almost all the work:
 *
 *   53 m   width at the base of the pyramid (175 ft square)
 *  212 m   the apex of the pyramid proper — the 48th floor is well below it
 *  260 m   the top of the aluminium-clad spire
 *  105 m   the 29th floor, where the two wings break out of the slope
 *
 * The wings are the detail everyone forgets. The east wing carries the lifts,
 * the west wing the stairs and the smoke shaft; because they are *vertical*
 * while the pyramid leans in around them, they start flush at the 29th floor
 * and end up projecting nearly thirteen metres by the apex. Without them the
 * silhouette is a plain triangle and reads as generic. With them it is
 * instantly the Transamerica from any angle.
 *
 * Cladding is crushed-quartz precast — very pale, slightly warm, and it is
 * *mostly* what you see: the windows are narrow slots between wide precast
 * mullions, so the tower reads white with fine dark pinstriping. Building it
 * the other way around (glass tower with thin white lines) is the single most
 * common mistake in models of it.
 */
import * as THREE from "three";
import * as M from "./materials";
import { box, loft, rectRing, strut, taperBox, xform } from "./kit";
import { streetYaw, type LandmarkCtx, type LandmarkModule } from "./types";
import type { LandmarkDef } from "../../geo/sfGeo";

const BASE_TOP = 16; // top of the plinth / entrance level
const APEX = 212;
const SPIRE_TOP = 260;
const HALF_BASE = 26.5;
const HALF_APEX = 3.05;
const WING_START = 105;
const WING_HALF_W = 5.9; // half width across the face
const FLOORS = 48;

/** Plan half-width of the pyramid at elevation y (relative to ground). */
function halfAt(y: number): number {
  if (y <= BASE_TOP) return HALF_BASE;
  const t = Math.min(1, (y - BASE_TOP) / (APEX - BASE_TOP));
  return HALF_BASE + (HALF_APEX - HALF_BASE) * t;
}

/** Outer plane of the wings — vertical, fixed at the 29th-floor plan. */
const WING_OUT = halfAt(WING_START);

function build(ctx: LandmarkCtx): void {
  const { batch, detail } = ctx;
  const g = ctx.originY;
  const quartz = M.quartzPrecast();
  const glass = M.curtainGlass(0x9fb4c6);
  const concrete = M.concrete(0xd2ccc0);

  /* ---------------- plinth + entrance colonnade ---------------- */
  // The tower does not touch the ground: it stands on a ring of exposed
  // precast legs with diagonal braces, and you walk under it into the plaza.
  batch.add(concrete, box(HALF_BASE * 2 + 6, 1.4, HALF_BASE * 2 + 6), xform(0, g + 0.7, 0));
  const legGeo = box(2.1, BASE_TOP - 1.4, 2.1);
  const legs = batch.instances(concrete, legGeo);
  const braceGeo = box(1.3, 1, 1.3);
  const braces = batch.instances(concrete, braceGeo);
  const legN = detail ? 8 : 4;
  for (let side = 0; side < 4; side++) {
    const a = (side * Math.PI) / 2;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    for (let i = 0; i <= legN; i++) {
      const u = (i / legN - 0.5) * 2 * HALF_BASE;
      const px = cos * HALF_BASE - sin * u;
      const pz = sin * HALF_BASE + cos * u;
      legs.atPos(px, g + 1.4 + (BASE_TOP - 1.4) / 2, pz, a);
      if (detail && i < legN) {
        // Diagonal braces between adjacent legs — the visible truss that makes
        // the base look like an oil rig and the tower look like it is floating.
        const u2 = ((i + 1) / legN - 0.5) * 2 * HALF_BASE;
        const ax0 = cos * HALF_BASE - sin * u;
        const az0 = sin * HALF_BASE + cos * u;
        const ax1 = cos * HALF_BASE - sin * u2;
        const az1 = sin * HALF_BASE + cos * u2;
        braces.at(strut(ax0, g + 2.4, az0, ax1, g + BASE_TOP - 1.4, az1, 1.3, 1.3));
        braces.at(strut(ax1, g + 2.4, az1, ax0, g + BASE_TOP - 1.4, az0, 1.3, 1.3));
      }
    }
  }
  // Lobby volume, inset behind the legs.
  batch.add(glass, box(HALF_BASE * 1.5, BASE_TOP - 2.6, HALF_BASE * 1.5), xform(0, g + BASE_TOP / 2, 0));
  batch.add(concrete, box(HALF_BASE * 2 + 4, 1.6, HALF_BASE * 2 + 4), xform(0, g + BASE_TOP, 0));
  ctx.collide.box(0, g + BASE_TOP / 2, 0, HALF_BASE, BASE_TOP / 2, HALF_BASE, 0, { walkable: false });

  /* ---------------- the pyramid shell ---------------- */
  // The shell itself is the glazing line. Floor bands push it in and out by
  // 120 mm — invisible individually, but they are what stops 200 m of sloped
  // wall from reading as a single flat facet.
  const rings: Float32Array[] = [];
  const bands = detail ? FLOORS * 2 : 8;
  for (let i = 0; i <= bands; i++) {
    const y = BASE_TOP + ((APEX - BASE_TOP) * i) / bands;
    const inset = detail && i % 2 === 1 ? 0.14 : 0;
    rings.push(rectRing((halfAt(y) - inset) * 2, (halfAt(y) - inset) * 2, g + y));
  }
  batch.add(glass, loft(rings, false, false));

  /* ---------------- precast mullions ---------------- */
  // Each mullion runs the whole height of the tower and converges on the apex,
  // so it is a single tapered loft, not a stack of boxes. Fifteen per face.
  const perFace = detail ? 15 : 5;
  const mullW = detail ? 2.3 : 6.6;
  for (let side = 0; side < 4; side++) {
    const a = (side * Math.PI) / 2;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    for (let i = 0; i < perFace; i++) {
      const u = ((i + 0.5) / perFace - 0.5) * 2; // -1..1 across the face
      const lo = new Float32Array(12);
      const hi = new Float32Array(12);
      const y0 = BASE_TOP;
      const y1 = APEX - 1;
      const h0 = halfAt(y0);
      const h1 = halfAt(y1);
      const corners: [number, number][] = [
        [-mullW / 2, 0],
        [mullW / 2, 0],
        [mullW / 2, 0.55],
        [-mullW / 2, 0.55],
      ];
      for (let k = 0; k < 4; k++) {
        const [du, dn] = corners[k];
        // Bottom ring, in face-local (u along the face, n outward).
        const bu = u * h0 + du;
        const bn = h0 + dn;
        lo[k * 3] = cos * bn - sin * bu;
        lo[k * 3 + 1] = g + y0;
        lo[k * 3 + 2] = sin * bn + cos * bu;
        const tu = u * h1 + du * (h1 / h0) * 0.55 + du * 0.45;
        const tn = h1 + dn;
        hi[k * 3] = cos * tn - sin * tu;
        hi[k * 3 + 1] = g + y1;
        hi[k * 3 + 2] = sin * tn + cos * tu;
      }
      batch.add(quartz, loft([lo, hi], true, true));
    }
    // Horizontal precast spandrel at every fourth floor — the visible banding.
    if (detail) {
      for (let f = 4; f < FLOORS; f += 4) {
        const y = BASE_TOP + ((APEX - BASE_TOP) * f) / FLOORS;
        const h = halfAt(y);
        batch.add(
          quartz,
          box(0.6, 1.1, h * 2 * 0.99),
          xform(cos * (h + 0.25), g + y, sin * (h + 0.25), a),
        );
      }
    }
  }

  /* ---------------- the wings ---------------- */
  for (const side of [0, 2]) {
    const a = (side * Math.PI) / 2;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const rows = detail ? 20 : 3;
    const wingRings: Float32Array[] = [];
    for (let r = 0; r <= rows; r++) {
      const y = WING_START + ((APEX - 2 - WING_START) * r) / rows;
      const inner = halfAt(y) - 0.4;
      const outer = WING_OUT;
      const ring = new Float32Array(12);
      const pts: [number, number][] = [
        [inner, -WING_HALF_W],
        [outer, -WING_HALF_W],
        [outer, WING_HALF_W],
        [inner, WING_HALF_W],
      ];
      for (let k = 0; k < 4; k++) {
        const [n, u] = pts[k];
        ring[k * 3] = cos * n - sin * u;
        ring[k * 3 + 1] = g + y;
        ring[k * 3 + 2] = sin * n + cos * u;
      }
      wingRings.push(ring);
    }
    batch.add(quartz, loft(wingRings, true, true));
    if (!detail) continue;
    // The wings are blank precast except for a single line of slot windows on
    // the outer face of the lift shaft.
    for (let y = WING_START + 8; y < APEX - 8; y += 8.2) {
      batch.add(
        glass,
        box(0.5, 2.6, 1.5),
        xform(cos * (WING_OUT + 0.2), g + y, sin * (WING_OUT + 0.2), a),
      );
    }
  }

  /* ---------------- apex and spire ---------------- */
  batch.add(quartz, taperBox(HALF_APEX * 2, HALF_APEX * 2, 3.4, 3.4, 5), xform(0, g + APEX - 1, 0));
  // The spire is a clad lattice: four corner posts, ring stiffeners, and light
  // panels between. It tapers to nothing and carries the beacon.
  const spireH = SPIRE_TOP - (APEX + 4);
  const spirePosts = batch.instances(M.paintedColour(0xd8d5cd, 1.2), box(0.34, 1, 0.34));
  const spireRings = batch.instances(M.paintedColour(0xc9c6be, 1.2), box(1, 0.22, 1));
  const steps = detail ? 16 : 5;
  for (let i = 0; i < steps; i++) {
    const t0 = i / steps;
    const t1 = (i + 1) / steps;
    const y0 = APEX + 4 + spireH * t0;
    const y1 = APEX + 4 + spireH * t1;
    const w0 = 1.7 * (1 - t0 * 0.86);
    const w1 = 1.7 * (1 - t1 * 0.86);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        spirePosts.atPos(
          (sx * (w0 + w1)) / 2,
          g + (y0 + y1) / 2,
          (sz * (w0 + w1)) / 2,
          0,
          0,
          0,
          1,
          y1 - y0,
          1,
        );
      }
    }
    spireRings.atPos(0, g + y1, 0, 0, 0, 0, w1 * 2.2, 1, w1 * 2.2);
  }
  // Cladding skin so the spire is a solid white needle from a distance.
  batch.add(
    M.paintedColour(0xe4e1d8, 1.6),
    taperBox(3.2, 3.2, 0.5, 0.5, spireH),
    xform(0, g + APEX + 4, 0),
  );

  /* ---------------- the beacon ---------------- */
  const beaconMat = M.emitter(0xff3020, 7);
  const beaconGeo = new THREE.SphereGeometry(0.75, 10, 8);
  batch.add(beaconMat, beaconGeo, xform(0, g + SPIRE_TOP + 0.9, 0));
  beaconGeo.dispose();
  // The aircraft warning light is a slow strobe, not a steady lamp. One sine
  // and one material — cheap, and it makes the skyline feel alive at dusk.
  ctx.onFrame((t) => {
    const pulse = 0.5 + 0.5 * Math.sin(t * 2.2);
    beaconMat.emissiveIntensity = 2 + pulse * pulse * 9;
  });

  /* ---------------- collision: the sloped shell ---------------- */
  // A stack of boxes following the taper. Coarse, but it is what makes the
  // pyramid grappleable and stops a wingsuit passing through the apex.
  const layers = 10;
  for (let i = 0; i < layers; i++) {
    const y0 = BASE_TOP + ((APEX - BASE_TOP) * i) / layers;
    const y1 = BASE_TOP + ((APEX - BASE_TOP) * (i + 1)) / layers;
    const h = halfAt((y0 + y1) / 2);
    ctx.collide.box(0, g + (y0 + y1) / 2, 0, h, (y1 - y0) / 2, h, 0, { walkable: false });
  }
  ctx.collide.box(0, g + APEX + 2, 0, 4.5, 3, 4.5, 0, { walkable: true });
}

export const transamerica: LandmarkModule = {
  yaw: (def: LandmarkDef) => streetYaw(def.x, def.z, 0),
  build,
  nearRange: (def) => Math.max(1400, def.radius * 14),
  anchor: true,
};
