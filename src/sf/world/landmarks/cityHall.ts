/**
 * San Francisco City Hall — Bakewell & Brown, 1915.
 *
 * The single best Beaux-Arts building on the West Coast, and its one bragging
 * right is the dome: 93.7 m to the tip of the lantern, taller than the dome of
 * the United States Capitol, and the fifth tallest in the world. That fact is
 * the whole design brief for this model — everything is scaled so the dome
 * *dominates*, because in real life it does.
 *
 * Anatomy, bottom to top:
 *   0–8 m    rusticated granite base, arched openings
 *   8–30 m   the giant order: engaged Doric columns two storeys tall, running
 *            the full 155 m of the Polk Street front
 *   30–34 m  entablature, balustrade, attic
 *   34–55 m  the drum — a circular colonnade of paired columns with windows
 *            behind, standing on a square podium
 *   55–79 m  the dome proper: sixteen gilded ribs over lead-grey panels
 *   79–94 m  lantern, cupola, gilt finial
 *
 * The gold is real gold leaf on the real building (re-gilded in 1998 with
 * 23.5 carat), so it gets a genuine metal material rather than a yellow tint —
 * at sunset it should be the brightest object in the Civic Center.
 */
import * as THREE from "three";
import * as M from "./materials";
import {
  archedPanel,
  box,
  circleRing,
  column,
  cornice,
  lathe,
  loft,
  stairs,
  xform,
} from "./kit";
import { streetYaw, type LandmarkCtx, type LandmarkModule } from "./types";
import type { LandmarkDef } from "../../geo/sfGeo";

const W = 155;
const D = 82;
const BASE = 8;
const CORNICE = 30;
const ATTIC = 35;
const DRUM_BASE = 36;
const DRUM_TOP = 56;
const DOME_TOP = 79;
const LANTERN_TOP = 88;
const FINIAL = 93.7;
const DRUM_R = 15.5;

function build(ctx: LandmarkCtx): void {
  const { batch, detail } = ctx;
  const g = ctx.originY;
  const granite = M.civicStone(0xddd7c8);
  const shade = M.civicStone(0xc0b9a8);
  const dark = M.civicStone(0x8f897c);
  const gold = M.goldLeaf();
  const glass = M.curtainGlass(0x4e5a62);
  const seg = detail ? 48 : 18;

  /* ---------------- the block ---------------- */
  batch.add(shade, box(W + 3, BASE, D + 3), xform(0, g + BASE / 2, 0));
  batch.add(granite, box(W, CORNICE - BASE, D), xform(0, g + (CORNICE + BASE) / 2, 0));
  batch.add(shade, box(W + 4.5, 2.4, D + 4.5), xform(0, g + CORNICE + 1.2, 0));
  batch.add(granite, box(W - 2, ATTIC - CORNICE - 2.4, D - 2), xform(0, g + (ATTIC + CORNICE + 2.4) / 2, 0));
  batch.add(shade, box(W, 1.4, D), xform(0, g + ATTIC + 0.7, 0));
  ctx.collide.box(0, g + CORNICE / 2, 0, W / 2, CORNICE / 2, D / 2, 0, { walkable: false });
  ctx.collide.box(0, g + ATTIC + 0.7, 0, W / 2, 0.7, D / 2, 0, { walkable: true });

  /* ---------------- the giant order ---------------- */
  // Engaged Doric columns, two storeys tall, on all four elevations. There are
  // a great many of them and they are the building's texture, so they are
  // instanced at full detail and become flat pilasters far away.
  const colH = CORNICE - BASE - 1.5;
  const colGeo = column(colH, 1.15, detail, "doric");
  const cols = batch.instances(granite, colGeo);
  const spacing = 6.6;
  const nx = Math.floor((W - 14) / spacing);
  const nz = Math.floor((D - 14) / spacing);
  for (let i = 0; i <= nx; i++) {
    const x = -((nx * spacing) / 2) + i * spacing;
    for (const s of [-1, 1]) cols.atPos(x, g + BASE, s * (D / 2 + 0.4));
  }
  for (let i = 0; i <= nz; i++) {
    const z = -((nz * spacing) / 2) + i * spacing;
    for (const s of [-1, 1]) cols.atPos(s * (W / 2 + 0.4), g + BASE, z);
  }
  colGeo.dispose();

  // Base arcade: round-headed openings between rusticated piers.
  if (detail) {
    const arch = archedPanel(6.4, BASE, 1.2, 3.2, 6.4);
    const arcade = batch.instances(shade, arch);
    for (let i = 0; i <= nx; i++) {
      const x = -((nx * spacing) / 2) + i * spacing;
      for (const s of [-1, 1]) arcade.atPos(x, g, s * (D / 2 + 0.3), s > 0 ? 0 : Math.PI);
    }
    // Windows behind the colonnade.
    const win = batch.instances(glass, box(3.4, 8.4, 0.4));
    for (let i = 0; i < nx; i++) {
      const x = -((nx * spacing) / 2) + (i + 0.5) * spacing;
      for (const s of [-1, 1]) win.atPos(x, g + BASE + 6, s * (D / 2 - 0.2));
    }
    // Balustraded parapet on the attic.
    const baluster = batch.instances(granite, box(0.36, 1.15, 0.36));
    for (let i = 0; i < 92; i++) {
      const x = -W / 2 + (W * i) / 91;
      for (const s of [-1, 1]) baluster.atPos(x, g + ATTIC + 2, s * (D / 2 - 0.5));
    }
    batch.add(
      shade,
      cornice(W, [0, CORNICE - 2.2, 2.2, CORNICE - 1.2, 2.6, CORNICE + 0.2, 1.4, CORNICE + 1.2, 0, CORNICE + 1.6], -1),
      xform(0, g, D / 2 + 0.2),
    );
    batch.add(
      shade,
      cornice(W, [0, CORNICE - 2.2, 2.2, CORNICE - 1.2, 2.6, CORNICE + 0.2, 1.4, CORNICE + 1.2, 0, CORNICE + 1.6], -1),
      xform(0, g, -D / 2 - 0.2, Math.PI),
    );
  }

  /* ---------------- the Polk Street portico ---------------- */
  const pW = 34;
  batch.add(shade, box(pW + 6, 1.6, 12), xform(0, g + 0.8, D / 2 + 7));
  batch.add(M.paving(0xb8b1a3), stairs(9, 0.16, 0.42, pW + 10), xform(0, g, D / 2 + 14.4, 0, 0, 0, 1, 1, 1));
  const pColGeo = column(CORNICE - 2, 1.7, detail, "corinthian");
  const pCols = batch.instances(granite, pColGeo);
  for (let i = 0; i < 6; i++) {
    pCols.atPos(-pW / 2 + (pW * i) / 5, g + 1.6, D / 2 + 6.2);
  }
  pColGeo.dispose();
  batch.add(granite, box(pW + 8, 3.4, 13), xform(0, g + CORNICE + 0.1, D / 2 + 5.5));
  // Pediment: a shallow triangular gable over the portico.
  const ped = new Float32Array([
    -(pW + 8) / 2, g + CORNICE + 1.8, D / 2 + 12,
    (pW + 8) / 2, g + CORNICE + 1.8, D / 2 + 12,
    (pW + 8) / 2, g + CORNICE + 1.8, D / 2 - 1,
    -(pW + 8) / 2, g + CORNICE + 1.8, D / 2 - 1,
  ]);
  const pedTop = new Float32Array([
    -0.4, g + CORNICE + 9, D / 2 + 12,
    0.4, g + CORNICE + 9, D / 2 + 12,
    0.4, g + CORNICE + 9, D / 2 - 1,
    -0.4, g + CORNICE + 9, D / 2 - 1,
  ]);
  batch.add(granite, loft([ped, pedTop], true, true));
  ctx.collide.box(0, g + 0.8, D / 2 + 7, pW / 2 + 3, 0.8, 6, 0, { walkable: true });

  /* ---------------- the drum ---------------- */
  batch.add(granite, box(46, DRUM_BASE - ATTIC + 1, 46), xform(0, g + (DRUM_BASE + ATTIC) / 2, 0));
  // Cylindrical wall with the windows, then the free-standing paired columns.
  batch.add(
    granite,
    loft([circleRing(DRUM_R - 1.6, g + DRUM_BASE, seg), circleRing(DRUM_R - 1.6, g + DRUM_TOP, seg)], false, false),
  );
  if (detail) {
    const dwin = batch.instances(glass, archedPanel(3.6, 13, 0.5, 2.4, 11));
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      dwin.atPos(Math.cos(a) * (DRUM_R - 1.9), g + DRUM_BASE + 2.5, Math.sin(a) * (DRUM_R - 1.9), -a + Math.PI / 2);
    }
  }
  const dColGeo = column(DRUM_TOP - DRUM_BASE - 3.5, 0.92, detail, "corinthian");
  const dCols = batch.instances(granite, dColGeo);
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    for (const off of [-0.14, 0.14]) {
      const aa = a + off;
      dCols.atPos(Math.cos(aa) * DRUM_R, g + DRUM_BASE + 1.2, Math.sin(aa) * DRUM_R, -aa);
    }
  }
  dColGeo.dispose();
  // Drum entablature + balustrade.
  batch.add(
    shade,
    loft(
      [
        circleRing(DRUM_R + 1.5, g + DRUM_TOP - 2.4, seg),
        circleRing(DRUM_R + 2.2, g + DRUM_TOP - 1.4, seg),
        circleRing(DRUM_R + 2.0, g + DRUM_TOP, seg),
        circleRing(DRUM_R - 1.0, g + DRUM_TOP + 0.6, seg),
      ],
      false,
      false,
    ),
  );
  ctx.collide.box(0, g + (DRUM_BASE + DRUM_TOP) / 2, 0, DRUM_R + 2, (DRUM_TOP - DRUM_BASE) / 2, DRUM_R + 2, 0, {
    walkable: false,
  });

  /* ---------------- the dome ---------------- */
  // Lead-grey panels between sixteen gilded ribs. The profile is a slightly
  // stilted hemisphere — it rises from the drum on a short vertical before it
  // starts curving, which is exactly what makes a dome look tall instead of
  // squat, and is the difference between this and the Capitol.
  const domeH = DOME_TOP - DRUM_TOP;
  const domeRings: Float32Array[] = [];
  const rows = detail ? 18 : 6;
  const domeR = (t: number) => {
    const stilt = Math.min(1, t / 0.16);
    const curve = Math.cos((Math.max(0, t - 0.1) / 0.9) * (Math.PI / 2));
    return (DRUM_R - 0.5) * (0.06 * (1 - stilt) + curve * 0.94 + 0.06);
  };
  for (let r = 0; r <= rows; r++) {
    const t = r / rows;
    domeRings.push(circleRing(Math.max(0.6, domeR(t)), g + DRUM_TOP + domeH * t, seg));
  }
  batch.add(M.paintedColour(0x8d9299, 2.6), loft(domeRings, false, false));

  const ribs = detail ? 16 : 8;
  for (let i = 0; i < ribs; i++) {
    const a = (i / ribs) * Math.PI * 2;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const ringsR: Float32Array[] = [];
    for (let r = 0; r <= rows; r++) {
      const t = r / rows;
      const rad = Math.max(0.6, domeR(t)) + 0.25;
      const y = g + DRUM_TOP + domeH * t;
      const w = 0.75 * (1 - t * 0.5);
      ringsR.push(
        new Float32Array([
          cos * rad - sin * -w, y, sin * rad + cos * -w,
          cos * (rad + 0.4) - sin * -w * 0.7, y, sin * (rad + 0.4) + cos * -w * 0.7,
          cos * (rad + 0.4) - sin * w * 0.7, y, sin * (rad + 0.4) + cos * w * 0.7,
          cos * rad - sin * w, y, sin * rad + cos * w,
        ]),
      );
    }
    batch.add(gold, loft(ringsR, true, true));
  }

  /* ---------------- lantern and finial ---------------- */
  const lanternR = 4.2;
  batch.add(shade, loft([circleRing(lanternR + 1.2, g + DOME_TOP - 0.6, seg), circleRing(lanternR + 1.2, g + DOME_TOP + 0.8, seg)], false, false));
  const lColGeo = column(LANTERN_TOP - DOME_TOP - 3, 0.42, detail, "corinthian");
  const lCols = batch.instances(granite, lColGeo);
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    lCols.atPos(Math.cos(a) * lanternR, g + DOME_TOP + 0.8, Math.sin(a) * lanternR, -a);
  }
  lColGeo.dispose();
  batch.add(
    M.emitter(0xffd9a0, 1.6),
    new THREE.CylinderGeometry(lanternR - 1.2, lanternR - 1.2, LANTERN_TOP - DOME_TOP - 2, detail ? 16 : 8, 1, true),
    xform(0, g + DOME_TOP + 1 + (LANTERN_TOP - DOME_TOP - 2) / 2, 0),
  );
  batch.add(gold, lathe(
    [
      lanternR + 0.8, g + LANTERN_TOP - 2,
      lanternR + 0.2, g + LANTERN_TOP - 0.8,
      lanternR * 0.7, g + LANTERN_TOP,
      lanternR * 0.32, g + LANTERN_TOP + 2.2,
      0.9, g + FINIAL - 2.6,
      1.5, g + FINIAL - 2.0,
      0.55, g + FINIAL - 1.2,
      0, g + FINIAL,
    ],
    detail ? 20 : 8,
  ));
  ctx.collide.box(0, g + DOME_TOP, 0, lanternR + 2, 1.2, lanternR + 2, 0, { walkable: true });

  /* ---------------- Civic Center Plaza edge ---------------- */
  batch.add(M.paving(0xada69a), box(W + 46, 0.4, 30), xform(0, g + 0.2, D / 2 + 24));
  if (detail) {
    const lampPost = batch.instances(M.darkSteel(), box(0.22, 6.4, 0.22));
    const lampGlobe = batch.instances(M.emitter(0xffdaa8, 2.4), new THREE.SphereGeometry(0.4, 8, 6));
    for (let i = -6; i <= 6; i++) {
      if (Math.abs(i) < 2) continue;
      lampPost.atPos(i * 12, g + 3.2, D / 2 + 20);
      lampGlobe.atPos(i * 12, g + 6.7, D / 2 + 20);
    }
  }
}

export const cityHall: LandmarkModule = {
  // The Polk Street front faces east down the Civic Center axis.
  yaw: (def: LandmarkDef) => streetYaw(def.x, def.z, 0),
  build,
  nearRange: (def) => Math.max(1100, def.radius * 12),
  anchor: true,
};
