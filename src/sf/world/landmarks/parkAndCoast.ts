/**
 * The western half of the city — the four places you walk to when you have
 * left downtown behind, and which between them are most of what San Francisco
 * looks like on a postcard that is not the bridge.
 *
 *   Conservatory of Flowers  The oldest wood-and-glass Victorian glasshouse in
 *                            the western hemisphere: a white ribbed dome on a
 *                            cruciform plan, sitting alone at the top of a
 *                            lawn. It reads from four hundred metres purely
 *                            because it is white and everything around it is
 *                            green.
 *   de Young Museum          Copper, perforated and dimpled, oxidising unevenly
 *                            — and a twisted observation tower that rotates
 *                            through 90° as it rises, so its top is aligned to
 *                            the city grid while its base is aligned to the
 *                            park. The twist is the building.
 *   Cliff House & Sutro      A white modernist box on the last rock before the
 *   Baths                    Pacific, above the flooded concrete footings of
 *                            what was once the largest swimming complex in the
 *                            world. The ruin is the interesting half.
 *   Twin Peaks               Two bald hills, a hairpin road, and the crescent
 *                            of parapet everybody in the world has stood at to
 *                            photograph Market Street running dead straight
 *                            into downtown.
 */
import * as THREE from "three";
import * as M from "./materials";
import { box, lathe, loft, ribbon, stairs, xform } from "./kit";
import { type LandmarkCtx, type LandmarkModule } from "./types";
import type { LandmarkDef } from "../../geo/sfGeo";

/* ================================================================== *
 * Conservatory of Flowers
 * ================================================================== */

const CONS_W = 74;
const CONS_D = 26;
const CONS_WALL = 5.4;
const CONS_DOME = 18.5;

/** One barrel-vaulted wing: glazed walls, a half-round roof, white ribs. */
function conservatoryWing(
  ctx: LandmarkCtx,
  cx: number,
  cz: number,
  len: number,
  width: number,
  yaw: number,
  frame: THREE.Material,
  glass: THREE.Material,
): void {
  const { batch, detail } = ctx;
  const g = ctx.originY;
  const half = width / 2;

  batch.add(glass, box(len, CONS_WALL, width), xform(cx, g + CONS_WALL / 2, cz, yaw));
  batch.add(frame, box(len + 0.5, 0.5, width + 0.5), xform(cx, g + 0.3, cz, yaw));
  batch.add(frame, box(len + 0.4, 0.4, width + 0.4), xform(cx, g + CONS_WALL, cz, yaw));

  // The barrel: a half-cylinder lofted from semicircular rings so the ridge is
  // a real curve rather than a gable pretending to be one.
  const rings: Float32Array[] = [];
  const seg = detail ? 14 : 7;
  const arc = (x: number): Float32Array => {
    const pts: number[] = [];
    for (let i = 0; i <= seg; i++) {
      const a = Math.PI * (i / seg);
      pts.push(x, g + CONS_WALL + Math.sin(a) * half * 0.92, Math.cos(a) * half);
    }
    return new Float32Array(pts);
  };
  rings.push(arc(-len / 2), arc(len / 2));
  batch.add(glass, loft(rings, false, false), xform(cx, 0, cz, yaw));

  if (detail) {
    // Glazing bars, every 2.6 m. This is the whole silhouette of the building.
    const rib = batch.instances(frame, box(0.22, 0.22, width * 1.02));
    const bows = Math.max(3, Math.round(len / 2.6));
    for (let i = 0; i <= bows; i++) {
      const x = -len / 2 + (len * i) / bows;
      for (let j = 0; j < seg; j++) {
        const a0 = (Math.PI * j) / seg;
        const a1 = (Math.PI * (j + 1)) / seg;
        const y0 = Math.sin(a0) * half * 0.92;
        const z0 = Math.cos(a0) * half;
        const y1 = Math.sin(a1) * half * 0.92;
        const z1 = Math.cos(a1) * half;
        const segLen = Math.hypot(y1 - y0, z1 - z0);
        rib.at(
          xform(
            cx + Math.cos(yaw) * x,
            g + CONS_WALL + (y0 + y1) / 2,
            cz - Math.sin(yaw) * x,
            yaw,
            0,
            Math.atan2(y1 - y0, z1 - z0),
            0.22,
            0.22,
            segLen,
          ),
        );
      }
    }
  }
}

function buildConservatory(ctx: LandmarkCtx): void {
  const { batch, detail } = ctx;
  const g = ctx.originY;
  const white = M.paintedWhite();
  /**
   * Glasshouse glazing, not curtain wall. `curtainGlass` is tuned for an
   * office tower — dark, reflective, and reading as near-black against a
   * bright sky, which is exactly right on Salesforce Tower and exactly wrong
   * here: the Conservatory is white, and the thing that makes it visible from
   * across the meadow is that it glows rather than that it reflects. A pale
   * emissive stands in for a hundred thousand panes with a jungle lit behind
   * them.
   */
  const glass = M.emitter(0xdff0e8, 0.55);
  const plinth = M.civicStone(0xd8d4c8);

  // A raised terrace, because the building stands on a slope above the lawn.
  batch.add(plinth, box(CONS_W + 12, 1.6, CONS_D + 12), xform(0, g + 0.8, 0));
  batch.add(plinth, stairs(5, 0.32, 0.9, 14), xform(0, g, CONS_D / 2 + 6, Math.PI / 2));
  ctx.collide.box(0, g + 0.8, 0, CONS_W / 2 + 6, 0.8, CONS_D / 2 + 6, 0, { walkable: true });

  // Cruciform plan: a long east–west range with a short cross-wing.
  conservatoryWing(ctx, 0, 0, CONS_W, CONS_D * 0.52, 0, white, glass);
  conservatoryWing(ctx, 0, 0, CONS_D + 12, CONS_D * 0.44, Math.PI / 2, white, glass);

  /* ---- the dome over the crossing ---- */
  const domeR = CONS_D * 0.31;
  const profile: number[] = [];
  const steps = detail ? 12 : 6;
  for (let i = 0; i <= steps; i++) {
    const a = (Math.PI / 2) * (i / steps);
    profile.push(Math.cos(a) * domeR, g + CONS_WALL + 1.2 + Math.sin(a) * CONS_DOME * 0.62);
  }
  batch.add(glass, lathe(profile, detail ? 20 : 10), xform(0, 0, 0));
  batch.add(white, lathe([domeR + 0.5, g + CONS_WALL + 0.6, domeR + 0.5, g + CONS_WALL + 1.4], 20), xform(0, 0, 0));
  // Lantern and finial.
  batch.add(white, lathe(
    [2.1, g + CONS_WALL + 1.2 + CONS_DOME * 0.62, 2.1, g + CONS_WALL + 4.4 + CONS_DOME * 0.62,
     1.1, g + CONS_WALL + 5.6 + CONS_DOME * 0.62, 0, g + CONS_WALL + 8.2 + CONS_DOME * 0.62],
    detail ? 14 : 8,
  ), xform(0, 0, 0));
  ctx.collide.box(0, g + CONS_WALL / 2 + 1.6, 0, CONS_W / 2, CONS_WALL / 2 + 1.6, CONS_D * 0.26, 0, {
    walkable: false,
  });

  if (detail) {
    // The formal flower beds in front, which are as photographed as the house.
    const bed = batch.instances(M.foliage(0xc0567a), box(9, 0.5, 3.4));
    for (let i = -2; i <= 2; i++) {
      bed.atPos(i * 11, g + 0.35, CONS_D / 2 + 15, 0);
    }
    batch.add(M.grass(0x6f8c4a), box(CONS_W + 60, 0.3, 44), xform(0, g - 0.9, CONS_D / 2 + 30));
  }
}

export const conservatoryOfFlowers: LandmarkModule = {
  yaw: (def: LandmarkDef) => def.rotation,
  build: buildConservatory,
  nearRange: (def) => Math.max(700, def.radius * 9),
};

/* ================================================================== *
 * de Young Museum
 * ================================================================== */

const DEYOUNG_TOWER_H = 44;

function buildDeYoung(ctx: LandmarkCtx): void {
  const { batch, detail } = ctx;
  const g = ctx.originY;
  // Oxidising copper: the building was delivered bright and is now green in
  // patches, which is the point of having chosen copper.
  const copper = M.weatheredSteel();
  const copperLit = M.brightMetal(0x8a6a44);
  const glass = M.curtainGlass(0xb8c6c2);

  /* ---- the long gallery bars ---- */
  const bars: [number, number, number, number, number][] = [
    [-26, 0, 96, 34, 12],
    [18, -14, 62, 26, 9.5],
    [22, 26, 54, 22, 8],
  ];
  for (const [bx, bz, len, wid, h] of bars) {
    batch.add(copper, box(len, h, wid), xform(bx, g + h / 2, bz));
    batch.add(M.flatRoof(), box(len + 0.4, 0.5, wid + 0.4), xform(bx, g + h + 0.2, bz));
    ctx.collide.box(bx, g + h / 2, bz, len / 2, h / 2, wid / 2, 0, { walkable: false });
    ctx.collide.box(bx, g + h + 0.25, bz, len / 2, 0.25, wid / 2, 0, { walkable: true });
    if (detail) {
      // The perforated dimple pattern, as a band of recessed panels.
      const dimple = batch.instances(copperLit, box(1.5, 1.5, 0.12));
      for (let i = 0; i < Math.round(len / 4); i++) {
        for (let j = 0; j < Math.max(1, Math.round(h / 4)); j++) {
          dimple.atPos(
            bx - len / 2 + 2 + i * 4,
            g + 2 + j * 4,
            bz + wid / 2 + 0.06,
          );
        }
      }
    }
  }
  batch.add(glass, box(28, 9, 3), xform(-4, g + 4.5, -17));

  /* ---- the twisting tower ---- */
  // Nine stacked rings, each rotated 10° from the last: 90° of twist from the
  // park's alignment at the base to the city grid's at the top.
  const rings: Float32Array[] = [];
  const levels = detail ? 10 : 5;
  const hw = 13;
  const hd = 10;
  for (let i = 0; i <= levels; i++) {
    const t = i / levels;
    const a = t * (Math.PI / 2);
    const y = g + t * DEYOUNG_TOWER_H;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const pts: number[] = [];
    for (const [px, pz] of [
      [-hw, -hd],
      [hw, -hd],
      [hw, hd],
      [-hw, hd],
    ] as const) {
      pts.push(px * c - pz * s, y, px * s + pz * c);
    }
    rings.push(new Float32Array(pts));
  }
  batch.add(copper, loft(rings, false, true), xform(-58, 0, -34));
  batch.add(glass, box(24, 4.5, 18), xform(-58, g + DEYOUNG_TOWER_H - 2.6, -34, Math.PI / 2));
  batch.add(M.flatRoof(), box(26, 0.6, 20), xform(-58, g + DEYOUNG_TOWER_H + 0.2, -34, Math.PI / 2));
  ctx.collide.box(-58, g + DEYOUNG_TOWER_H / 2, -34, hw + 1, DEYOUNG_TOWER_H / 2, hd + 1, 0, {
    walkable: false,
  });
  // The observation deck is the whole reason anyone climbs it.
  ctx.collide.box(-58, g + DEYOUNG_TOWER_H + 0.3, -34, 13, 0.3, 10, Math.PI / 2, { walkable: true });

  if (detail) {
    batch.add(M.paving(0xbdb6a8), box(140, 0.3, 96), xform(0, g - 0.1, 0));
    const tree = batch.instances(M.foliage(0x4f7a3c), lathe([0, 0, 4.6, 3.2, 3.4, 7.4, 0, 10], 7));
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      tree.atPos(Math.cos(a) * 86, g, Math.sin(a) * 62);
    }
  }
}

export const deYoungMuseum: LandmarkModule = {
  yaw: (def: LandmarkDef) => def.rotation,
  build: buildDeYoung,
  nearRange: (def) => Math.max(900, def.radius * 10),
};

/* ================================================================== *
 * Cliff House & the Sutro Baths
 * ================================================================== */

function buildCliffHouse(ctx: LandmarkCtx): void {
  const { batch, detail } = ctx;
  const white = M.paintedWhite();
  const glass = M.curtainGlass(0xa8bcc4);
  const ruin = M.concrete(0x9a958a);
  const pool = M.stillWater(0x27403c);

  /* ---- Cliff House: a white box cantilevered over the drop ---- */
  const hg = ctx.ground(0, 0);
  batch.add(white, box(46, 11, 19), xform(0, hg + 5.5, 0));
  batch.add(glass, box(44, 6.5, 0.6), xform(0, hg + 6.4, -9.4));
  batch.add(white, box(48, 1.0, 21), xform(0, hg + 11.2, 0));
  batch.add(white, box(26, 8, 15), xform(12, hg + 15, 2));
  batch.add(glass, box(24.5, 5, 0.6), xform(12, hg + 15.4, -5.3));
  batch.add(white, box(28, 0.9, 17), xform(12, hg + 19.4, 2));
  ctx.collide.box(0, hg + 5.5, 0, 23, 5.5, 9.5, 0, { walkable: false });
  ctx.collide.box(0, hg + 11.4, 0, 24, 0.5, 10.5, 0, { walkable: true });
  ctx.collide.box(12, hg + 15, 2, 13, 4, 7.5, 0, { walkable: false });
  ctx.collide.box(12, hg + 19.6, 2, 14, 0.45, 8.5, 0, { walkable: true });

  // The terrace on the seaward side, and the railing along the drop.
  batch.add(M.paving(0xb4aea2), box(52, 0.4, 12), xform(0, hg + 0.2, -16));
  ctx.collide.box(0, hg + 0.2, -16, 26, 0.2, 6, 0, { walkable: true });
  if (detail) {
    const post = batch.instances(M.galvanised(), box(0.12, 1.1, 0.12));
    for (let i = 0; i <= 26; i++) post.atPos(-26 + i * 2, hg + 0.95, -21.6);
    batch.add(M.galvanised(), box(52, 0.09, 0.09), xform(0, hg + 1.5, -21.6));
  }

  /* ---- Sutro Baths: the ruin, north and below ---- */
  // Rectangular concrete tanks stepping down to the sea, most of them flooded.
  const tanks: [number, number, number, number][] = [
    [-56, -84, 44, 30],
    [-52, -120, 34, 26],
    [-96, -100, 28, 34],
    [-16, -108, 26, 22],
  ];
  for (const [tx, tz, tw, td] of tanks) {
    const tg = ctx.ground(tx, tz);
    const rim = Math.max(tg, 2.2);
    // Walls, then a water plane a metre down inside them.
    for (const [ox, oz, sw, sd] of [
      [0, -td / 2, tw, 1.4],
      [0, td / 2, tw, 1.4],
      [-tw / 2, 0, 1.4, td],
      [tw / 2, 0, 1.4, td],
    ] as const) {
      batch.add(ruin, box(sw, 3.2, sd), xform(tx + ox, rim - 0.4, tz + oz));
      ctx.collide.box(tx + ox, rim - 0.4, tz + oz, sw / 2, 1.6, sd / 2, 0, { walkable: true });
    }
    batch.add(pool, box(tw - 2.8, 0.2, td - 2.8), xform(tx, rim - 1.3, tz));
  }
  if (detail) {
    // Snapped columns and stubs of wall — what is actually left out there.
    const stub = batch.instances(ruin, box(1.1, 3.4, 1.1));
    const rng = ctx.rng;
    for (let i = 0; i < 26; i++) {
      const sx = rng.range(-110, 0);
      const sz = rng.range(-140, -70);
      const sg = ctx.ground(sx, sz);
      stub.atPos(
        sx, Math.max(sg, 2) + 1.2, sz,
        rng.range(0, 3), 0, rng.range(-0.08, 0.08),
        1, rng.range(0.5, 1.8), 1,
      );
    }
  }
}

export const cliffHouse: LandmarkModule = {
  yaw: (def: LandmarkDef) => def.rotation,
  build: buildCliffHouse,
  nearRange: (def) => Math.max(800, def.radius * 8),
};

/* ================================================================== *
 * Twin Peaks
 * ================================================================== */

function buildTwinPeaks(ctx: LandmarkCtx): void {
  const { batch, detail } = ctx;
  const asphalt = M.asphalt();
  const stone = M.civicStone(0xa8a49a);
  const rail = M.galvanised();

  /**
   * The overlook is a crescent of parapet on the shoulder below the north
   * peak, facing due east down Market Street. The road up is a hairpin, and
   * both halves are traced here as ribbons on the real terrain rather than
   * placed flat — the hill under them rises 90 m across this landmark.
   */
  const R = 46;
  const pts: THREE.Vector3[] = [];
  const seg = detail ? 26 : 12;
  for (let i = 0; i <= seg; i++) {
    const a = -1.15 + (2.3 * i) / seg;
    const px = Math.cos(a) * R;
    const pz = Math.sin(a) * R;
    pts.push(new THREE.Vector3(px, ctx.ground(px, pz) + 0.35, pz));
  }
  batch.add(stone, ribbon(pts, 7, 0.5), xform(0, 0, 0));
  ctx.collide.ribbon(pts, 7, 0.5, { walkable: true, drivable: false });

  // Parapet wall along the outer edge.
  const wall = batch.instances(stone, box(2.4, 1.0, 0.55));
  for (let i = 0; i < seg; i++) {
    const a = -1.15 + (2.3 * (i + 0.5)) / seg;
    const px = Math.cos(a) * (R + 7);
    const pz = Math.sin(a) * (R + 7);
    wall.atPos(px, ctx.ground(px, pz) + 0.85, pz, -a);
  }
  if (detail) {
    const post = batch.instances(rail, box(0.1, 1.0, 0.1));
    for (let i = 0; i <= seg; i++) {
      const a = -1.15 + (2.3 * i) / seg;
      const px = Math.cos(a) * (R + 7.1);
      const pz = Math.sin(a) * (R + 7.1);
      post.atPos(px, ctx.ground(px, pz) + 1.85, pz);
    }
  }

  // The hairpin: two legs of road meeting at a switchback west of the parapet.
  const road: THREE.Vector3[] = [];
  for (let i = 0; i <= (detail ? 20 : 8); i++) {
    const t = i / (detail ? 20 : 8);
    const px = -30 - t * 150;
    const pz = -70 + Math.sin(t * Math.PI * 1.15) * 120;
    road.push(new THREE.Vector3(px, ctx.ground(px, pz) + 0.25, pz));
  }
  batch.add(asphalt, ribbon(road, 5.2, 0.35), xform(0, 0, 0));
  ctx.collide.ribbon(road, 5.2, 0.35, { drivable: true, walkable: true });

  // The two summits themselves get a cap of scree so they are not bald mesh.
  if (detail) {
    const rock = batch.instances(M.concrete(0x8d8778), lathe([0, 0, 3.2, 1.1, 2.2, 2.4, 0, 3.2], 6));
    const rng = ctx.rng;
    for (let i = 0; i < 40; i++) {
      const sx = rng.range(-160, 160);
      const sz = rng.range(-160, 160);
      rock.atPos(sx, ctx.ground(sx, sz), sz, rng.range(0, 3.1), 0, 0, rng.range(0.5, 1.5));
    }
  }
}

export const twinPeaksOverlook: LandmarkModule = {
  yaw: (def: LandmarkDef) => def.rotation,
  build: buildTwinPeaks,
  nearRange: (def) => Math.max(600, def.radius * 6),
};
