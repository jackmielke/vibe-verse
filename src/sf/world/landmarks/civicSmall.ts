/**
 * Three small landmarks that are all about a single silhouette:
 *
 *   Grace Cathedral      French Gothic in reinforced concrete, on the crest of
 *                        Nob Hill. Two 53 m west towers, a rose window, and
 *                        flying buttresses that are structurally decorative —
 *                        the building is a concrete frame pretending to be
 *                        Chartres, and it commits to the lie beautifully.
 *   Dragon Gate          The Grant Avenue paifang: three openings, green glazed
 *                        tile with upturned eaves, dragons and fish. It is the
 *                        threshold of Chinatown and reads at 200 m because of
 *                        the roof curve, nothing else.
 *   Powell St turnaround The wooden cable car turntable at Market. Five metres
 *                        of decking that men push a twelve-tonne car around by
 *                        hand, and it is where every visitor's day begins.
 */
import * as THREE from "three";
import * as M from "./materials";
import {
  box,
  circleRing,
  gableRoof,
  hipRoof,
  lancetPanel,
  lathe,
  loft,
  stairs,
  xform,
} from "./kit";
import { streetYaw, type LandmarkCtx, type LandmarkModule } from "./types";
import type { LandmarkDef } from "../../geo/sfGeo";

/* ================================================================== *
 * Grace Cathedral
 * ================================================================== */

const NAVE_L = 100;
const NAVE_W = 17;
const AISLE_W = 9;
const WALL_H = 26;
const ROOF_H = 13;
const TOWER = 53;

function buildGrace(ctx: LandmarkCtx): void {
  const { batch, detail } = ctx;
  const g = ctx.originY;
  const stone = M.civicStone(0xd4cec0);
  const shade = M.civicStone(0xb6b0a2);
  const roofMat = M.roofTile(0x7d7d78);
  const glassMat = M.litGlass(0x8f6ad0, 1.4);

  /* ---- nave + aisles ---- */
  batch.add(stone, box(NAVE_L, WALL_H, NAVE_W), xform(0, g + WALL_H / 2, 0));
  batch.add(roofMat, gableRoof(NAVE_L, NAVE_W, ROOF_H, 0.8), xform(0, g + WALL_H, 0));
  for (const s of [-1, 1]) {
    batch.add(stone, box(NAVE_L, WALL_H * 0.56, AISLE_W), xform(0, g + WALL_H * 0.28, s * (NAVE_W / 2 + AISLE_W / 2)));
    batch.add(
      roofMat,
      gableRoof(NAVE_L, AISLE_W, 3.4, 0.6),
      xform(0, g + WALL_H * 0.56, s * (NAVE_W / 2 + AISLE_W / 2)),
    );
  }
  ctx.collide.box(0, g + WALL_H / 2, 0, NAVE_L / 2, WALL_H / 2 + ROOF_H / 2, NAVE_W / 2 + AISLE_W, 0, {
    walkable: false,
  });

  /* ---- clerestory + aisle windows ---- */
  const lancet = lancetPanel(4.6, 12, 0.6, 2.6, 9);
  const win = batch.instances(glassMat, lancet);
  const jamb = batch.instances(shade, lancetPanel(5.4, 13, 0.5, 3.2, 9.8));
  const bays = detail ? 11 : 4;
  for (let i = 0; i < bays; i++) {
    const x = -NAVE_L / 2 + (NAVE_L * (i + 0.5)) / bays;
    for (const s of [-1, 1]) {
      win.atPos(x, g + WALL_H * 0.56 + 1.4, s * (NAVE_W / 2 - 0.1), s > 0 ? 0 : Math.PI);
      jamb.atPos(x, g + WALL_H * 0.56 + 0.9, s * (NAVE_W / 2 + 0.2), s > 0 ? 0 : Math.PI);
      win.atPos(x, g + 3, s * (NAVE_W / 2 + AISLE_W - 0.1), s > 0 ? 0 : Math.PI);
    }
  }

  /* ---- flying buttresses ---- */
  if (detail) {
    for (let i = 0; i <= bays; i++) {
      const x = -NAVE_L / 2 + (NAVE_L * i) / bays;
      for (const s of [-1, 1]) {
        const z0 = s * (NAVE_W / 2 + 0.4);
        const z1 = s * (NAVE_W / 2 + AISLE_W + 1.4);
        // Pier, then the flyer arcing up to the clerestory wall, then a pinnacle.
        batch.add(stone, box(2.2, WALL_H * 0.62, 2.6), xform(x, g + WALL_H * 0.31, z1));
        const len = Math.hypot(z1 - z0, WALL_H * 0.34);
        const ang = Math.atan2(WALL_H * 0.34, Math.abs(z1 - z0));
        ROT.makeRotationX(-s * ang);
        batch.add(stone, box(1.1, 1.4, len), xform(x, g + WALL_H * 0.78, (z0 + z1) / 2).multiply(ROT));
        batch.add(shade, box(2.6, 2, 3.0), xform(x, g + WALL_H * 0.62 + 1, z1));
        batch.add(
          stone,
          lathe([1.2, g + WALL_H * 0.62 + 2, 0.9, g + WALL_H * 0.62 + 4, 0.35, g + WALL_H * 0.62 + 8, 0, g + WALL_H * 0.62 + 9.5], 6),
          xform(x, 0, z1),
        );
      }
    }
  }

  /* ---- west front: two towers and the rose window ---- */
  const fx = -NAVE_L / 2;
  batch.add(stone, box(9, WALL_H + 6, NAVE_W + AISLE_W * 2), xform(fx - 4, g + (WALL_H + 6) / 2, 0));
  for (const s of [-1, 1]) {
    const tz = s * (NAVE_W / 2 + AISLE_W / 2 + 1);
    const rings: Float32Array[] = [];
    for (const [w, y] of [
      [13, 0],
      [12.4, 20],
      [11.6, TOWER - 8],
      [11.2, TOWER - 6],
    ] as const) {
      rings.push(
        new Float32Array([
          -w / 2, g + y, -w / 2, w / 2, g + y, -w / 2, w / 2, g + y, w / 2, -w / 2, g + y, w / 2,
        ]),
      );
    }
    batch.add(stone, loft(rings, false, true), xform(fx - 4, 0, tz));
    // Belfry openings and the corner pinnacles.
    if (detail) {
      const bell = batch.instances(M.civicStone(0x2b2a27), lancetPanel(3.4, 9, 0.5, 2.2, 7.5));
      for (let f = 0; f < 4; f++) {
        const a = (f * Math.PI) / 2;
        bell.atPos(
          fx - 4 + Math.cos(a) * 5.7,
          g + TOWER - 17,
          tz + Math.sin(a) * 5.7,
          a,
        );
      }
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          batch.add(
            stone,
            lathe([1.5, g + TOWER - 6, 1.1, g + TOWER - 3, 0.4, g + TOWER + 3, 0, g + TOWER + 5], 6),
            xform(fx - 4 + sx * 5.4, 0, tz + sz * 5.4),
          );
        }
      }
    }
    batch.add(shade, box(12, 1.4, 12), xform(fx - 4, g + TOWER - 5.3, tz));
    ctx.collide.box(fx - 4, g + TOWER / 2, tz, 6.5, TOWER / 2, 6.5, 0, { walkable: false });
    ctx.collide.box(fx - 4, g + TOWER - 5.3, tz, 6, 0.7, 6, 0, { walkable: true });
  }
  // The rose window: a wheel of radiating tracery in the west gable.
  const roseR = 5.6;
  batch.add(glassMat, new THREE.CylinderGeometry(roseR, roseR, 0.5, detail ? 32 : 12).rotateZ(Math.PI / 2), xform(fx - 8.4, g + 21, 0));
  if (detail) {
    const spoke = batch.instances(shade, box(0.6, 0.55, roseR * 2));
    for (let i = 0; i < 12; i++) {
      spoke.atPos(fx - 8.7, g + 21, 0, 0, (i / 12) * Math.PI, 0);
    }
    batch.add(shade, lathe([roseR, 0, roseR + 0.8, 0.35, roseR, 0.7], 24).rotateZ(Math.PI / 2), xform(fx - 8.8, g + 21, 0));
    batch.add(shade, lathe([roseR * 0.34, 0, roseR * 0.42, 0.3, roseR * 0.34, 0.6], 16).rotateZ(Math.PI / 2), xform(fx - 8.9, g + 21, 0));
  }
  // Great west doors under a deep pointed portal.
  batch.add(M.civicStone(0x3a2c22), lancetPanel(9, 12, 1.6, 5, 10.5), xform(fx - 8.6, g, 0, Math.PI / 2));

  /* ---- crossing fleche ---- */
  const cx = NAVE_L * 0.12;
  batch.add(stone, box(11, 8, 11), xform(cx, g + WALL_H + ROOF_H - 1, 0));
  batch.add(
    roofMat,
    hipRoof(9, 9, 17, 0.4),
    xform(cx, g + WALL_H + ROOF_H + 3, 0),
  );
  batch.add(M.goldLeaf(), box(0.3, 5, 0.3), xform(cx, g + WALL_H + ROOF_H + 22, 0));

  /* ---- the terrace Grace sits on ---- */
  batch.add(M.paving(0xb4ada0), box(NAVE_L + 34, 1.2, NAVE_W + AISLE_W * 2 + 30), xform(0, g + 0.6, 0));
  batch.add(M.paving(0xc0b9ab), stairs(7, 0.17, 0.4, 26), xform(fx - 9, g - 0.6, 0, Math.PI));
}

const ROT = new THREE.Matrix4();

export const graceCathedral: LandmarkModule = {
  yaw: (def: LandmarkDef) => streetYaw(def.x, def.z, Math.PI / 2),
  build: buildGrace,
  nearRange: (def) => Math.max(700, def.radius * 12),
};

/* ================================================================== *
 * Dragon Gate
 * ================================================================== */

/**
 * A pagoda roof tier. The upturned eave is the entire point: the corners of a
 * Chinese roof sweep upward on a curve, and a straight hip roof reads as a
 * garden shed with green tiles on it.
 */
function pagodaRoof(
  ctx: LandmarkCtx,
  cx: number,
  cy: number,
  w: number,
  d: number,
  h: number,
  tile: THREE.Material,
): void {
  const { batch, detail } = ctx;
  const seg = detail ? 8 : 3;
  const rings: Float32Array[] = [];
  for (let i = 0; i <= seg; i++) {
    const t = i / seg;
    // The eave line droops then flicks up at the corners: modelled by scaling
    // the ring in and lifting it on a curve that overshoots at the perimeter.
    const shrink = Math.pow(t, 0.8);
    const y = cy + h * Math.pow(t, 1.55);
    const hw = (w / 2) * (1 - shrink * 0.94);
    const hd = (d / 2) * (1 - shrink * 0.94);
    const pts: number[] = [];
    const N = 16;
    for (let k = 0; k < N; k++) {
      const a = (k / N) * Math.PI * 2;
      // Square-ish ring with corners pulled out and up.
      const c = Math.cos(a);
      const s = Math.sin(a);
      const m = Math.max(Math.abs(c), Math.abs(s));
      const corner = Math.pow(Math.min(Math.abs(c), Math.abs(s)) / m, 2);
      const lift = corner * (1 - t) * h * 0.42;
      pts.push(cx + (c / m) * hw * (1 + corner * 0.1), y + lift, (s / m) * hd * (1 + corner * 0.1));
    }
    rings.push(new Float32Array(pts));
  }
  batch.add(tile, loft(rings, true, true));
}

function buildChinatownGate(ctx: LandmarkCtx): void {
  const { batch, detail } = ctx;
  const g = ctx.originY;
  const stoneMat = M.civicStone(0xd8d2c4);
  const tile = M.terracotta(0x5d8f5a);
  const red = M.paintedColour(0xa8332a, 1.2);
  const gold = M.goldLeaf();

  const colH = 8.4;
  const gapC = 5.2; // centre opening half-width
  const gapS = 3.2;
  const xs = [-(gapC + gapS + 1.4), -gapC, gapC, gapC + gapS + 1.4];

  // Four stone columns on carved bases.
  for (const x of xs) {
    const outer = Math.abs(x) > gapC + 0.1;
    const h = outer ? colH * 0.78 : colH;
    batch.add(stoneMat, box(1.3, 0.9, 1.9), xform(x, g + 0.45, 0));
    batch.add(stoneMat, box(1.0, h, 1.4), xform(x, g + 0.9 + h / 2, 0));
    if (detail) {
      // Guardian lion at the foot of each outer column.
      if (outer) {
        batch.add(stoneMat, box(1.1, 0.5, 1.6), xform(x, g + 1.15, 1.7));
        batch.add(stoneMat, box(0.8, 0.9, 0.9), xform(x, g + 1.85, 1.9));
        batch.add(stoneMat, new THREE.SphereGeometry(0.34, 8, 6), xform(x, g + 2.45, 2.05));
      }
    }
    ctx.collide.box(x, g + h / 2, 0, 0.6, h / 2, 0.8, 0, { walkable: false });
  }

  // Beams over each opening, with red-and-gold panelling.
  const beam = (x0: number, x1: number, y: number, h: number) => {
    batch.add(red, box(x1 - x0, h, 1.5), xform((x0 + x1) / 2, g + y + h / 2, 0));
    if (detail) {
      batch.add(gold, box(x1 - x0 - 0.6, 0.22, 1.62), xform((x0 + x1) / 2, g + y + h - 0.3, 0));
      batch.add(gold, box(x1 - x0 - 0.6, 0.22, 1.62), xform((x0 + x1) / 2, g + y + 0.3, 0));
    }
  };
  beam(xs[0], xs[3], 6.6, 0.9);
  beam(-gapC, gapC, 9.3, 1.5);
  if (detail) {
    // Dougong bracket sets under the eaves — the stacked timber corbels.
    const bracket = batch.instances(red, box(0.34, 0.34, 2.1));
    for (let i = 0; i < 22; i++) {
      const x = -10.5 + i;
      bracket.atPos(x, g + 7.7, 0);
      bracket.atPos(x, g + 8.15, 0, 0, 0, 0, 1.3, 1, 0.8);
    }
  }

  // Roofs: side tiers, then the taller centre tier.
  pagodaRoof(ctx, (xs[0] + xs[1]) / 2 - 0.2, g + 7.5, gapS + 4.2, 4.4, 2.2, tile);
  pagodaRoof(ctx, (xs[2] + xs[3]) / 2 + 0.2, g + 7.5, gapS + 4.2, 4.4, 2.2, tile);
  pagodaRoof(ctx, 0, g + 10.8, gapC * 2 + 4.4, 5.2, 3.0, tile);
  // Ridge with the paired dragons chasing the pearl.
  batch.add(tile, box(gapC * 2 + 3, 0.5, 0.7), xform(0, g + 13.6, 0));
  if (detail) {
    for (const s of [-1, 1]) {
      batch.add(gold, box(1.5, 0.4, 0.4), xform(s * (gapC + 0.6), g + 14.0, 0, 0, 0, s * 0.5));
      batch.add(gold, new THREE.SphereGeometry(0.22, 8, 6), xform(s * (gapC - 0.4), g + 14.3, 0));
    }
    batch.add(gold, new THREE.SphereGeometry(0.38, 10, 8), xform(0, g + 14.2, 0));
    // The plaque: "All under heaven is for the good of the people."
    batch.add(M.civicStone(0x2a2725), box(4.2, 1.0, 0.18), xform(0, g + 11.6, 0.85));
  }
}

export const chinatownGate: LandmarkModule = {
  yaw: (def: LandmarkDef) => streetYaw(def.x, def.z, Math.PI / 2),
  build: buildChinatownGate,
  nearRange: (def) => Math.max(320, def.radius * 14),
};

/* ================================================================== *
 * Powell Street cable car turnaround
 * ================================================================== */

function buildTurnaround(ctx: LandmarkCtx): void {
  const { batch, detail } = ctx;
  const g = ctx.originY;
  const timber = M.deckTimber(0xa9977c);
  const rail = M.brightMetal(0xb9bcc0);
  const seg = detail ? 32 : 12;

  /* ---- the brick apron and the pit ---- */
  batch.add(M.brick(0xc07a5e), box(22, 0.35, 18), xform(0, g + 0.17, 0));
  ctx.collide.box(0, g + 0.17, 0, 11, 0.2, 9, 0, { walkable: true });
  batch.add(
    M.concrete(0x9b958a),
    loft([circleRing(3.4, g - 0.6, seg), circleRing(3.4, g + 0.3, seg)], true, false),
  );

  /* ---- the turntable itself ---- */
  // A timber deck on a central pivot with two rails across it. Men push the
  // car around by hand; it is the last hand-operated turntable in the world.
  const deck = loft([circleRing(3.2, g + 0.28, seg), circleRing(3.2, g + 0.42, seg)], false, true);
  batch.add(timber, deck, xform(0, 0, 0));
  for (const s of [-1, 1]) {
    batch.add(rail, box(6.4, 0.14, 0.09), xform(0, g + 0.48, s * 0.53));
  }
  if (detail) {
    // Radial deck planks read as the wheel it is.
    const plank = batch.instances(M.deckTimber(0x9a8a70), box(3.1, 0.05, 0.22));
    for (let i = 0; i < 28; i++) {
      const a = (i / 28) * Math.PI * 2;
      plank.atPos(Math.cos(a) * 1.6, g + 0.44, Math.sin(a) * 1.6, -a);
    }
  }

  /* ---- the approach tracks and the slot ---- */
  for (const s of [-1, 1]) {
    for (const t of [-0.53, 0.53]) {
      batch.add(rail, box(9, 0.14, 0.09), xform(s * 7.6, g + 0.42, t));
    }
    batch.add(M.darkSteel(), box(9, 0.12, 0.11), xform(s * 7.6, g + 0.4, 0));
  }

  /* ---- the parked car ---- */
  if (detail) {
    const body = M.paintedColour(0x7d2b24, 1.0);
    const cream = M.paintedColour(0xe8dcc0, 1.0);
    const roof = M.paintedColour(0xc9bda2, 1.0);
    batch.add(body, box(8.6, 1.7, 2.3), xform(0, g + 1.5, 0));
    batch.add(cream, box(8.62, 0.5, 2.32), xform(0, g + 2.55, 0));
    batch.add(roof, box(9.4, 0.18, 2.7), xform(0, g + 3.15, 0));
    const postGeo = box(0.09, 0.75, 0.09);
    const posts = batch.instances(M.brightMetal(0xc8a250), postGeo);
    for (let i = 0; i < 8; i++) {
      for (const s of [-1, 1]) {
        posts.atPos(-3.9 + i * 1.1, g + 2.68, s * 1.28);
      }
    }
    // Open front bench and the grip lever.
    batch.add(cream, box(2, 0.16, 2.1), xform(-3.4, g + 1.2, 0));
    batch.add(M.brightMetal(0x9aa0a4), box(0.1, 1.1, 0.1), xform(-2.5, g + 2.1, 0));
    // Wheels.
    const wheel = new THREE.CylinderGeometry(0.36, 0.36, 0.1, 10);
    wheel.rotateX(Math.PI / 2);
    const wheels = batch.instances(M.darkSteel(), wheel);
    for (const wx of [-2.6, -1.9, 1.9, 2.6]) {
      for (const s of [-1, 1]) wheels.atPos(wx, g + 0.72, s * 0.53);
    }
    wheel.dispose();
    ctx.collide.box(0, g + 2, 0, 4.3, 1.6, 1.4, 0, { walkable: false });
  }

  /* ---- queue rails, kiosk, and the sign ---- */
  if (detail) {
    const post = batch.instances(M.darkSteel(), box(0.07, 1.0, 0.07));
    const bar = batch.instances(M.darkSteel(), box(2.2, 0.06, 0.06));
    for (let i = 0; i < 10; i++) {
      post.atPos(-9 + i * 2.2, g + 0.85, 6.2);
      if (i < 9) bar.atPos(-7.9 + i * 2.2, g + 1.2, 6.2);
    }
    batch.add(M.paintedColour(0x3c4a44, 1.0), box(2.6, 2.6, 2.0), xform(8.6, g + 1.5, 5.4));
    batch.add(M.roofTile(0x8d8577), hipRoof(3.2, 2.6, 0.9, 0.3), xform(8.6, g + 2.8, 5.4));
    batch.add(M.emitter(0xffd79a, 2), box(1.6, 0.9, 0.06), xform(8.6, g + 2.0, 4.38));
  }
}

export const cableCarTurnaround: LandmarkModule = {
  yaw: (def: LandmarkDef) => streetYaw(def.x, def.z, 0),
  build: buildTurnaround,
  nearRange: (def) => Math.max(280, def.radius * 12),
};
