/**
 * The Palace of Fine Arts — Bernard Maybeck, 1915.
 *
 * Built for the Panama-Pacific Exposition out of plaster and burlap on a wood
 * frame, meant to last a year, and so beloved that the city rebuilt it in
 * concrete in the 1960s rather than let it fall down. Maybeck's brief to
 * himself was "a Roman ruin, mouldering, in a garden" — so it is deliberately
 * melancholic architecture, and the colour is the pinkish ochre of weathered
 * travertine rather than white marble.
 *
 * Three elements, and they only work together:
 *   the rotunda    an open octagon of eight Corinthian columns, 49 m to the top
 *                  of a coffered dome, with nothing inside it. It is a folly.
 *   the colonnade  two curved arcades sweeping away from the rotunda, columns
 *                  in groups of four, each group carrying a box on which stand
 *                  the weeping women who look down into planters they cannot
 *                  reach. Maybeck put them there to be sad.
 *   the lagoon     without the reflection this is a pile of concrete. The water
 *                  is half the composition and it is modelled as still water,
 *                  not as bay swell.
 */
import * as THREE from "three";
import * as M from "./materials";
import { box, circleRing, column, lathe, loft, shapedRing, xform } from "./kit";
import { streetYaw, type LandmarkCtx, type LandmarkModule } from "./types";
import type { LandmarkDef } from "../../geo/sfGeo";

const PODIUM = 4;
const COL_H = 26;
const ENTAB = COL_H + PODIUM; // 30
const ATTIC_TOP = 34;
const DOME_TOP = 49;
const ROT_R = 16.5;

function build(ctx: LandmarkCtx): void {
  const { batch, detail, rng } = ctx;
  const g = ctx.originY;
  // Maybeck's colour: warm ochre with a pink cast, weathered pale on the
  // exposed faces. Two tones of the same stone keep the mass from flattening.
  const stone = M.civicStone(0xe0c9a4);
  const deep = M.civicStone(0xc0a682);
  const shadeStone = M.civicStone(0xa8907a);
  const seg = detail ? 40 : 16;

  /* ================= the rotunda ================= */
  batch.add(deep, lathe([ROT_R + 7, g, ROT_R + 7, g + PODIUM * 0.4, ROT_R + 5.4, g + PODIUM * 0.5, ROT_R + 5.4, g + PODIUM], detail ? 32 : 12));
  ctx.collide.box(0, g + PODIUM / 2, 0, ROT_R + 6, PODIUM / 2, ROT_R + 6, 0, { walkable: true });

  const colGeo = column(COL_H, 1.45, detail, "corinthian");
  const cols = batch.instances(stone, colGeo);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    cols.atPos(Math.cos(a) * ROT_R, g + PODIUM, Math.sin(a) * ROT_R, -a);
    ctx.collide.box(Math.cos(a) * ROT_R, g + PODIUM + COL_H / 2, Math.sin(a) * ROT_R, 1.6, COL_H / 2, 1.6, -a, {
      walkable: false,
    });
  }
  colGeo.dispose();

  // Octagonal entablature over the columns: architrave, frieze, cornice.
  const oct = (r: number, y: number) => shapedRing(y, 8, () => r / Math.cos(Math.PI / 8));
  batch.add(
    stone,
    loft(
      [
        oct(ROT_R + 1.4, g + ENTAB - 3.2),
        oct(ROT_R + 1.6, g + ENTAB - 1.4),
        oct(ROT_R + 2.6, g + ENTAB - 0.6),
        oct(ROT_R + 2.4, g + ENTAB),
        oct(ROT_R + 0.4, g + ENTAB + 0.4),
      ],
      false,
      false,
    ),
  );
  // Attic storey with panelled recesses, then the dome springs.
  batch.add(deep, loft([oct(ROT_R - 0.6, g + ENTAB), oct(ROT_R - 1.4, g + ATTIC_TOP)], false, false));
  if (detail) {
    const panel = batch.instances(shadeStone, box(0.35, 2.4, 6.4));
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
      panel.atPos(Math.cos(a) * (ROT_R - 0.9), g + ENTAB + 2, Math.sin(a) * (ROT_R - 0.9), -a);
    }
  }

  /* ---- the coffered dome ---- */
  const domeH = DOME_TOP - ATTIC_TOP;
  const domeR = (t: number) => (ROT_R - 1.4) * Math.cos(t * (Math.PI / 2)) + 0.4;
  const rows = detail ? 14 : 5;
  const outer: Float32Array[] = [];
  const inner: Float32Array[] = [];
  for (let r = 0; r <= rows; r++) {
    const t = r / rows;
    outer.push(circleRing(Math.max(0.5, domeR(t)) + 0.9, g + ATTIC_TOP + domeH * t, seg));
    inner.push(circleRing(Math.max(0.4, domeR(t)), g + ATTIC_TOP + domeH * t, seg));
  }
  batch.add(deep, loft(outer, false, true));
  // The soffit, seen from below through the open octagon.
  batch.add(shadeStone, loft(inner.slice().reverse(), false, false));

  if (detail) {
    // Coffers: eight radial ribs and five horizontal rings, with recessed
    // panels between. Looking up into them is the reason to walk in here.
    const ribs = 16;
    for (let i = 0; i < ribs; i++) {
      const a = (i / ribs) * Math.PI * 2;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      const ringsR: Float32Array[] = [];
      for (let r = 0; r <= rows; r++) {
        const t = r / rows;
        const rad = Math.max(0.4, domeR(t)) - 0.15;
        const y = g + ATTIC_TOP + domeH * t;
        const w = 0.42;
        ringsR.push(
          new Float32Array([
            cos * rad - sin * -w, y, sin * rad + cos * -w,
            cos * (rad - 0.55) - sin * -w * 0.8, y, sin * (rad - 0.55) + cos * -w * 0.8,
            cos * (rad - 0.55) - sin * w * 0.8, y, sin * (rad - 0.55) + cos * w * 0.8,
            cos * rad - sin * w, y, sin * rad + cos * w,
          ]),
        );
      }
      batch.add(stone, loft(ringsR, false, false));
    }
    for (let r = 1; r < 5; r++) {
      const t = r / 5;
      const rad = Math.max(0.5, domeR(t));
      batch.add(
        stone,
        loft(
          [circleRing(rad - 0.5, g + ATTIC_TOP + domeH * t, seg), circleRing(rad - 0.1, g + ATTIC_TOP + domeH * t + 0.5, seg)],
          false,
          false,
        ),
      );
    }
    // Garlands hung between the capitals — Maybeck's swags.
    const swag = batch.instances(shadeStone, box(1, 0.55, 0.55));
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + Math.PI / 8 + Math.PI / 8;
      const len = 2 * ROT_R * Math.sin(Math.PI / 8) * 0.8;
      swag.atPos(Math.cos(a) * ROT_R * 0.96, g + ENTAB - 4.6, Math.sin(a) * ROT_R * 0.96, -a, 0, 0, len, 1, 1);
    }
  }

  /* ================= the colonnade ================= */
  // Two arcs sweeping around the lagoon. Radius and sweep are chosen so the
  // ends frame the rotunda when you stand on the far bank.
  const arcR = 82;
  const groups = detail ? 9 : 5;
  const gColGeo = column(14.5, 0.95, detail, "corinthian");
  const gCols = batch.instances(stone, gColGeo);
  for (const side of [-1, 1]) {
    for (let i = 0; i < groups; i++) {
      const a = Math.PI * 0.5 + side * (0.30 + (i / (groups - 1)) * 0.72);
      const cx = Math.cos(a) * arcR;
      const cz = Math.sin(a) * arcR - arcR + 6;
      const face = -a + Math.PI / 2;
      // A group of four: two by two, on a shared plinth.
      batch.add(deep, box(7.4, 2.2, 7.4), xform(cx, g + 1.1, cz, face));
      for (const du of [-2.1, 2.1]) {
        for (const dv of [-2.1, 2.1]) {
          const px = cx + Math.cos(face) * dv - Math.sin(face) * du;
          const pz = cz + Math.sin(face) * dv + Math.cos(face) * du;
          gCols.atPos(px, g + 2.2, pz, face);
        }
      }
      // The box the weeping women stand on.
      batch.add(stone, box(8.4, 3.6, 8.4), xform(cx, g + 18.5, cz, face));
      batch.add(deep, box(9.2, 0.7, 9.2), xform(cx, g + 20.6, cz, face));
      if (detail) {
        // The planters, and the four figures leaning into them with their
        // backs to the world. Suggested, not sculpted — but the pose reads.
        batch.add(shadeStone, lathe([2.2, g + 21, 2.6, g + 22.4, 2.2, g + 23.2, 1.9, g + 23.4], 12), xform(cx, 0, cz));
        for (let k = 0; k < 4; k++) {
          const ang = face + (k / 4) * Math.PI * 2;
          const px = cx + Math.cos(ang) * 3.1;
          const pz = cz + Math.sin(ang) * 3.1;
          batch.add(shadeStone, box(0.75, 2.5, 0.55), xform(px, g + 22.2, pz, -ang, 0.32, 0));
          batch.add(shadeStone, new THREE.SphereGeometry(0.32, 8, 6), xform(px + Math.cos(ang) * -0.5, g + 23.2, pz + Math.sin(ang) * -0.5));
        }
      }
      ctx.collide.box(cx, g + 10, cz, 4, 10, 4, face, { walkable: false });
    }
  }
  gColGeo.dispose();

  /* ================= the lagoon ================= */
  // A shallow basin in front of the rotunda. Terrain-conforming banks, then a
  // flat sheet of still water just below the bank line.
  const lagoonZ = 78;
  const lagoonR = 62;
  const bank: Float32Array[] = [];
  const waterY = g - 0.9;
  bank.push(
    shapedRing(g + 0.6, seg, (a) => lagoonR * (1 + 0.16 * Math.sin(a * 3)) + 12),
  );
  bank.push(
    shapedRing(waterY - 1.8, seg, (a) => lagoonR * (1 + 0.16 * Math.sin(a * 3)) * 0.86),
  );
  const bankGeo = loft(bank, false, true);
  bankGeo.translate(0, 0, lagoonZ);
  batch.add(M.civicStone(0x8d8474), bankGeo);
  const water = shapedRing(waterY, seg, (a) => lagoonR * (1 + 0.16 * Math.sin(a * 3)) * 0.92);
  const waterHub = shapedRing(waterY, seg, () => 0.5);
  const waterGeo = loft([water, waterHub], false, false);
  waterGeo.translate(0, 0, lagoonZ);
  batch.add(M.stillWater(0x28483f), waterGeo);

  if (detail) {
    // Reeds and cypresses around the bank, and the swans' island.
    const reeds = batch.instances(M.foliage(0x7c8f5a), box(1, 1, 0.06));
    const reedRng = rng.fork("reeds");
    for (let i = 0; i < 90; i++) {
      const a = reedRng.range(0, Math.PI * 2);
      const r = lagoonR * (1 + 0.16 * Math.sin(a * 3)) * reedRng.range(0.9, 0.99);
      const lx = Math.cos(a) * r;
      const lz = Math.sin(a) * r + lagoonZ;
      reeds.atPos(lx, waterY + 0.9, lz, reedRng.range(0, Math.PI), 0, 0, 1.6, 1.8, 1);
    }
    const trunk = batch.instances(M.deckTimber(0x7a705f), box(1, 1, 1));
    const canopy = batch.instances(M.foliage(0x53663f), box(1, 0.1, 1));
    const treeRng = rng.fork("cypress");
    for (let i = 0; i < 18; i++) {
      const a = treeRng.range(0, Math.PI * 2);
      const r = treeRng.range(lagoonR + 16, lagoonR + 46);
      const lx = Math.cos(a) * r;
      const lz = Math.sin(a) * r + lagoonZ;
      if (Math.hypot(lx, lz) < 46) continue;
      const gy = ctx.ground(lx, lz);
      const h = treeRng.range(11, 19);
      trunk.atPos(lx, gy + h / 2, lz, 0, 0, 0, 0.6, h, 0.6);
      for (let k = 0; k < 3; k++) {
        canopy.atPos(lx, gy + h * 0.74 + k * 1.6, lz, (k / 3) * Math.PI, 0, 0, 6.5 - k, 1, 6.5 - k);
      }
    }
  }
}

export const palaceOfFineArts: LandmarkModule = {
  yaw: (def: LandmarkDef) => streetYaw(def.x, def.z, Math.PI / 2),
  build,
  nearRange: (def) => Math.max(700, def.radius * 6),
};
