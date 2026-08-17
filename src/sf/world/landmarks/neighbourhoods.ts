/**
 * Six places that are landmarks because of what happens on the pavement in
 * front of them, not because of how tall they are. None of these would ever
 * have been worth modelling for a game you only fly over.
 *
 *   Union Square        A granite plaza one storey above its own car park,
 *                       four corners of steps, palms in a grid, and the Dewey
 *                       Monument — a 29 m Corinthian column with Victory on
 *                       top — dead centre.
 *   Ghirardelli Square  A red-brick chocolate factory turned into shops, and
 *                       the enormous roof sign that is the actual landmark:
 *                       seven and a half metres of letters visible from the
 *                       whole northern waterfront.
 *   Castro Theatre      A 1922 movie palace with a Spanish-colonial cast-stone
 *                       front, a neon blade sign, and a marquee that is the
 *                       single most photographed object in the district.
 *   Mission Dolores     The oldest surviving building in San Francisco — a
 *                       squat white adobe with four columns and a triple
 *                       bell-cote — standing next to the enormous 1918
 *                       basilica that was built beside it and dwarfs it.
 *   Fort Point          A three-tier brick casemate fort from 1861, sitting
 *                       directly underneath the Golden Gate's south end. The
 *                       bridge was re-engineered with a steel arch to avoid
 *                       demolishing it.
 *   Chase Center        A round arena on the Mission Bay waterfront: a ring of
 *                       glass and a shallow bowl roof.
 */
import * as THREE from "three";
import * as M from "./materials";
import {
  box,
  column,
  cornice,
  gableRoof,
  lathe,
  stairs,
  taperBox,
  xform,
} from "./kit";

import { streetYaw, type LandmarkCtx, type LandmarkModule } from "./types";
import type { LandmarkDef } from "../../geo/sfGeo";

/* ================================================================== *
 * Union Square
 * ================================================================== */

const SQ = 62;
const DEWEY_H = 29;

function buildUnionSquare(ctx: LandmarkCtx): void {
  const { batch, detail } = ctx;
  const g = ctx.originY;
  const granite = M.paving(0xbab3a6);
  const stone = M.civicStone(0xd6d0c2);
  const bronze = M.brightMetal(0x6b5a3c);

  /* ---- the raised plaza ---- */
  // A paved apron out to the surrounding streets first. `sfGeo` classifies any
  // exclusion zone with "Square" in its name as parkland and lays grass under
  // it, which is right for Washington Square and wrong for this one — Union
  // Square has not had a blade of grass on it since 1942.
  batch.add(M.paving(0xa8a196), box(190, 0.35, 190), xform(0, g - 0.1, 0));
  const deck = g + 1.35;
  batch.add(granite, box(SQ, 1.4, SQ), xform(0, deck - 0.7, 0));
  ctx.collide.box(0, deck - 0.7, 0, SQ / 2, 0.7, SQ / 2, 0, { walkable: true });
  // Steps up on all four sides — the thing everybody sits on.
  for (let s = 0; s < 4; s++) {
    const a = (s * Math.PI) / 2;
    batch.add(
      granite,
      stairs(4, 0.35, 0.55, SQ * 0.62),
      xform(Math.sin(a) * (SQ / 2 + 2.2), g, Math.cos(a) * (SQ / 2 + 2.2), a + Math.PI / 2),
    );
  }

  /* ---- the Dewey Monument ---- */
  batch.add(stone, box(9, 1.1, 9), xform(0, deck + 0.55, 0));
  batch.add(stone, taperBox(6.4, 6.4, 5.2, 5.2, 2.6), xform(0, deck + 1.1, 0));
  // A fluted Corinthian shaft. `column` is the kit's own, so the entasis and
  // the capital come for free.
  batch.add(stone, column(DEWEY_H - 6, 1.55, detail, "corinthian"), xform(0, deck + 3.7, 0));
  batch.add(stone, box(3.6, 0.7, 3.6), xform(0, deck + DEWEY_H - 2.0, 0));
  // Victory, as a figure rather than a person: at 29 m nobody resolves a face,
  // and a badly modelled one is far worse than a silhouette.
  batch.add(bronze, lathe([0, 0, 0.62, 0.5, 0.44, 2.1, 0.7, 2.9, 0, 3.6], detail ? 12 : 6),
    xform(0, deck + DEWEY_H - 1.6, 0));
  batch.add(bronze, box(2.9, 0.16, 0.5), xform(0, deck + DEWEY_H + 0.9, 0, 0.4));
  ctx.collide.box(0, deck + DEWEY_H / 2, 0, 2.4, DEWEY_H / 2, 2.4, 0, { walkable: false });

  if (detail) {
    // Palms in the grid they are actually planted in, and the hedge boxes.
    const trunk = batch.instances(M.civicStone(0x8e8272), lathe([0.55, 0, 0.42, 7, 0.34, 11], 7));
    const frond = batch.instances(M.foliage(0x4a6f33), box(7.4, 0.28, 1.5));
    for (const px of [-22, -8, 8, 22]) {
      for (const pz of [-22, 22]) {
        trunk.atPos(px, deck, pz);
        for (let f = 0; f < 7; f++) {
          frond.atPos(px, deck + 10.6, pz, (f / 7) * Math.PI * 2, -0.42, 0);
        }
      }
    }
    const hedge = batch.instances(M.foliage(0x3f6b34), box(11, 0.9, 2.2));
    for (const pz of [-14, 14]) {
      hedge.atPos(0, deck + 0.45, pz);
    }
  }
}

export const unionSquare: LandmarkModule = {
  yaw: (def: LandmarkDef) => streetYaw(def.x, def.z, 0),
  build: buildUnionSquare,
  nearRange: (def) => Math.max(600, def.radius * 8),
};

/* ================================================================== *
 * Ghirardelli Square
 * ================================================================== */

function buildGhirardelli(ctx: LandmarkCtx): void {
  const { batch, detail } = ctx;
  const g = ctx.originY;
  const red = M.brick(0x8d4a3a);
  const trim = M.paintedMasonry(0xd8cfc0);
  const sign = M.emitter(0xf2f0e6, 3.4);

  /* ---- the factory blocks, stepping up the slope ---- */
  const blocks: [number, number, number, number, number][] = [
    [0, 0, 58, 26, 16],
    [-38, -6, 34, 22, 12],
    [34, 8, 30, 24, 13],
  ];
  for (const [bx, bz, w, d, h] of blocks) {
    batch.add(red, box(w, h, d), xform(bx, g + h / 2, bz));
    batch.add(trim, box(w + 0.8, 0.7, d + 0.8), xform(bx, g + h + 0.3, bz));
    ctx.collide.box(bx, g + h / 2, bz, w / 2, h / 2, d / 2, 0, { walkable: false });
    ctx.collide.box(bx, g + h + 0.35, bz, w / 2, 0.35, d / 2, 0, { walkable: true });
    if (detail) {
      const win = batch.instances(M.litGlass(0xf0dcb0, 0.9), box(1.5, 2.4, 0.2));
      const cols = Math.max(2, Math.round(w / 4.4));
      const rowsN = Math.max(1, Math.round(h / 4.2));
      for (let c = 0; c < cols; c++) {
        for (let r = 0; r < rowsN; r++) {
          const wx = bx - w / 2 + 2.2 + c * ((w - 4.4) / Math.max(1, cols - 1));
          win.atPos(wx, g + 2.6 + r * 4.2, bz + d / 2 + 0.1);
          win.atPos(wx, g + 2.6 + r * 4.2, bz - d / 2 - 0.1, Math.PI);
        }
      }
    }
  }

  /* ---- the clock tower ---- */
  batch.add(red, box(13, 30, 13), xform(-38, g + 15, -6));
  batch.add(trim, box(14.5, 1.0, 14.5), xform(-38, g + 30.4, -6));
  batch.add(trim, lathe([7.4, g + 31, 5.6, g + 35, 2.2, g + 39, 0, g + 41], detail ? 12 : 6),
    xform(-38, 0, -6));
  ctx.collide.box(-38, g + 15, -6, 6.5, 15, 6.5, 0, { walkable: false });
  if (detail) {
    const face = batch.instances(M.paintedWhite(), lathe([0, 0, 2.1, 0.16, 2.1, 0.3], 14));
    for (let f = 0; f < 4; f++) {
      const a = (f * Math.PI) / 2;
      face.at(xform(-38 + Math.sin(a) * 6.6, g + 25.5, -6 + Math.cos(a) * 6.6, a, Math.PI / 2, 0));
    }
  }

  /**
   * The sign. This is the landmark, more than any of the brick under it: it
   * is 7.6 m tall, it is on the roof, and it is legible from Alcatraz. Built
   * as blocky letterforms on a frame rather than as text — a texture would be
   * unreadable at the angle you usually see it from, which is below it.
   */
  const roof = g + 16.6;
  batch.add(M.darkSteel(), box(46, 0.5, 1.2), xform(0, roof, 0));
  const post = batch.instances(M.darkSteel(), box(0.35, 8.2, 0.35));
  for (let i = 0; i <= 10; i++) post.atPos(-22 + i * 4.4, roof + 4.1, 0);
  // Eleven letters, each a slab, spaced like the real sign.
  const letter = batch.instances(sign, box(3.1, 7.0, 0.55));
  for (let i = 0; i < 11; i++) {
    letter.atPos(-21.5 + i * 4.3, roof + 4.4, 0.5);
  }
  ctx.collide.box(0, roof + 4.1, 0, 23, 4.1, 0.9, 0, { walkable: false });
}

export const ghirardelliSquare: LandmarkModule = {
  yaw: (def: LandmarkDef) => streetYaw(def.x, def.z, Math.PI),
  build: buildGhirardelli,
  nearRange: (def) => Math.max(800, def.radius * 10),
};

/* ================================================================== *
 * Castro Theatre
 * ================================================================== */

function buildCastro(ctx: LandmarkCtx): void {
  const { batch, detail } = ctx;
  const g = ctx.originY;
  const caststone = M.civicStone(0xd9cdb4);
  const shade = M.civicStone(0xb9ad94);
  const neon = M.emitter(0xff3a5c, 4.2);
  const bulb = M.emitter(0xffe6a8, 3.0);
  const roofMat = M.roofTile(0x8a5a44);

  /* ---- the auditorium behind, which is just a big shed ---- */
  batch.add(M.paintedMasonry(0xc9c0ad), box(30, 17, 52), xform(0, g + 8.5, 22));
  batch.add(M.flatRoof(), box(31, 0.6, 53), xform(0, g + 17.2, 22));
  ctx.collide.box(0, g + 8.5, 22, 15, 8.5, 26, 0, { walkable: false });
  ctx.collide.box(0, g + 17.4, 22, 15.5, 0.3, 26.5, 0, { walkable: true });

  /* ---- the front: a cast-stone facade far taller than the building ---- */
  batch.add(caststone, box(30, 24, 2.4), xform(0, g + 12, -5));
  batch.add(shade, box(31.5, 1.2, 3.4), xform(0, g + 24.4, -5));
  batch.add(roofMat, gableRoof(31.5, 4.2, 2.2, 0.7), xform(0, g + 25, -5));
  ctx.collide.box(0, g + 12, -5, 15, 12, 1.6, 0, { walkable: false });

  if (detail) {
    // The three arched bays and the pilasters between them.
    const pil = batch.instances(shade, box(1.5, 20, 1.1));
    for (const px of [-11.5, -4, 4, 11.5]) pil.atPos(px, g + 12, -6.3);
    const arch = batch.instances(M.litGlass(0xf2dcb4, 0.7), lathe([0, 0, 3.2, 0.4, 3.2, 0.9], 12));
    for (const px of [-7.6, 0, 7.6]) {
      arch.at(xform(px, g + 17.5, -6.4, 0, Math.PI / 2, 0));
    }
    batch.add(shade, cornice(30, [0, 0, 1.1, 0.5, 1.4, 1.1, 0.5, 1.6, 0, 1.9]), xform(0, g + 21.6, -5));
  }

  /* ---- the marquee ---- */
  batch.add(M.paintedWhite(), box(19, 2.9, 6.2), xform(0, g + 6.2, -9.4));
  batch.add(M.darkSteel(), box(19.6, 0.4, 6.8), xform(0, g + 7.8, -9.4));
  ctx.collide.box(0, g + 6.2, -9.4, 9.5, 1.45, 3.1, 0, { walkable: false });
  if (detail) {
    // The bulb chase around the marquee edge, which is the whole effect.
    const b = batch.instances(bulb, lathe([0, 0, 0.17, 0.1, 0.17, 0.2], 6));
    for (let i = 0; i < 26; i++) {
      const t = i / 25;
      b.atPos(-9.5 + t * 19, g + 4.6, -12.6);
      b.atPos(-9.5 + t * 19, g + 7.6, -12.6);
    }
    for (const sx of [-9.6, 9.6]) {
      for (let i = 0; i < 7; i++) b.atPos(sx, g + 4.7 + i * 0.5, -12.6);
    }
  }

  /**
   * The blade sign: vertical, projecting, and the reason you can find the
   * Castro from six blocks down Market. Letters stack downward on both faces.
   */
  batch.add(M.darkSteel(), box(0.5, 13, 3.4), xform(0, g + 16, -10.2));
  const letters = batch.instances(neon, box(0.24, 1.35, 2.4));
  for (let i = 0; i < 6; i++) {
    letters.atPos(0.4, g + 21 - i * 1.95, -10.2);
    letters.atPos(-0.4, g + 21 - i * 1.95, -10.2);
  }
  batch.add(neon, lathe([1.7, g + 22.4, 1.7, g + 23.0], 10), xform(0, 0, -10.2));
  ctx.collide.box(0, g + 16, -10.2, 0.6, 6.5, 1.9, 0, { walkable: false });
}

export const castroTheatre: LandmarkModule = {
  yaw: (def: LandmarkDef) => streetYaw(def.x, def.z, Math.PI),
  build: buildCastro,
  nearRange: (def) => Math.max(500, def.radius * 9),
};

/* ================================================================== *
 * Mission Dolores
 * ================================================================== */

function buildMissionDolores(ctx: LandmarkCtx): void {
  const { batch, detail } = ctx;
  const g = ctx.originY;
  const adobe = M.stucco(0xe4d9c2);
  const shade = M.stucco(0xc9bda4);
  const tile = M.roofTile(0x9c5a3e);
  const timber = M.deckTimber(0x6d5a42);

  /* ---- the 1791 adobe: small, thick-walled, and dead simple ---- */
  const W = 13.7;
  const L = 34;
  const H = 9.2;
  batch.add(adobe, box(W, H, L), xform(0, g + H / 2, 8));
  batch.add(tile, gableRoof(W + 1.6, L + 1.2, 3.4, 0.9), xform(0, g + H, 8, Math.PI / 2));
  ctx.collide.box(0, g + H / 2, 8, W / 2, H / 2 + 1.7, L / 2, 0, { walkable: false });

  // Four columns across the front, and the triple bell-cote above them.
  batch.add(adobe, box(W + 1.2, 2.6, 1.4), xform(0, g + H + 1.3, -9.6));
  if (detail) {
    const col = batch.instances(shade, column(H - 1.2, 0.42, detail, "doric"));
    for (const px of [-4.9, -1.6, 1.6, 4.9]) col.atPos(px, g, -9.4);
    batch.add(timber, box(W, 0.55, 2.2), xform(0, g + H - 1.0, -9.4));
  }
  // The bell-cote: three arched openings with a bell in each.
  batch.add(adobe, box(9.4, 4.6, 1.5), xform(0, g + H + 3.9, -9.6));
  const bellMat = M.brightMetal(0x5e4a2c);
  const bell = batch.instances(bellMat, lathe([0, 0, 0.52, 0.2, 0.62, 0.95, 0.2, 1.15], 8));
  const hole = batch.instances(shade, lathe([0, 0, 0.78, 0.3, 0.78, 0.6], 10));
  for (const px of [-3.1, 0, 3.1]) {
    bell.atPos(px, g + H + 3.0, -9.6);
    hole.at(xform(px, g + H + 3.9, -10.4, 0, Math.PI / 2, 0));
  }
  batch.add(tile, gableRoof(10.2, 2.4, 1.5, 0.5), xform(0, g + H + 6.2, -9.6, Math.PI / 2));

  /**
   * The basilica next door. It is the one people photograph by mistake, and
   * leaving it out makes the adobe look like it stands alone, which is the one
   * thing it conspicuously does not.
   */
  const bx = 26;
  batch.add(M.civicStone(0xe8e2d2), box(21, 21, 46), xform(bx, g + 10.5, 6));
  batch.add(tile, gableRoof(21, 46, 5.5, 1.1), xform(bx, g + 21, 6, Math.PI / 2));
  ctx.collide.box(bx, g + 10.5, 6, 10.5, 13, 23, 0, { walkable: false });
  for (const s of [-1, 1]) {
    const tx = bx + s * 8.5;
    batch.add(M.civicStone(0xe8e2d2), box(6.4, 34, 6.4), xform(tx, g + 17, -17));
    batch.add(tile, lathe([4.6, g + 34, 3.2, g + 38, 0, g + 43], detail ? 10 : 6), xform(tx, 0, -17));
    ctx.collide.box(tx, g + 17, -17, 3.2, 17, 3.2, 0, { walkable: false });
  }
  if (detail) {
    batch.add(M.litGlass(0x7a6ad0, 1.2),
      lathe([0, 0, 3.4, 0.3, 3.4, 0.6], 16), xform(bx, g + 15, -17.6, 0, Math.PI / 2, 0));
    // The cemetery garden, which is the other half of the site.
    batch.add(M.grass(0x5f7f42), box(24, 0.3, 30), xform(-16, g - 0.1, 10));
    const marker = batch.instances(M.civicStone(0xbdb6a4), box(0.6, 1.3, 0.22));
    const rng = ctx.rng;
    for (let i = 0; i < 24; i++) {
      marker.atPos(rng.range(-26, -6), g + 0.65, rng.range(-4, 24), rng.range(-0.12, 0.12));
    }
  }
}

export const missionDolores: LandmarkModule = {
  yaw: (def: LandmarkDef) => streetYaw(def.x, def.z, Math.PI),
  build: buildMissionDolores,
  nearRange: (def) => Math.max(600, def.radius * 9),
};

/* ================================================================== *
 * Fort Point
 * ================================================================== */

function buildFortPoint(ctx: LandmarkCtx): void {
  const { batch, detail } = ctx;
  const g = Math.max(ctx.originY, 2.0);
  const brickMat = M.brick(0x7d5442);
  const granite = M.civicStone(0x9c968a);

  /**
   * A hollow square of three-storey casemates around a parade ground, on a
   * granite plinth at the water's edge. Built as four ranges rather than as a
   * solid block with a hole, because the courtyard is the part you stand in.
   */
  const OUT = 33;
  const WALL = 9.5;
  const H = 14.5;
  batch.add(granite, box(OUT * 2 + 5, 2.2, OUT * 2 + 5), xform(0, g + 1.1, 0));
  ctx.collide.box(0, g + 1.1, 0, OUT + 2.5, 1.1, OUT + 2.5, 0, { walkable: true });

  const ranges: [number, number, number, number][] = [
    [0, -(OUT - WALL / 2), OUT * 2, WALL],
    [0, OUT - WALL / 2, OUT * 2, WALL],
    [-(OUT - WALL / 2), 0, WALL, (OUT - WALL) * 2],
    [OUT - WALL / 2, 0, WALL, (OUT - WALL) * 2],
  ];
  for (const [rx, rz, rw, rd] of ranges) {
    batch.add(brickMat, box(rw, H, rd), xform(rx, g + 2.2 + H / 2, rz));
    batch.add(granite, box(rw + 0.7, 0.9, rd + 0.7), xform(rx, g + 2.2 + H + 0.3, rz));
    ctx.collide.box(rx, g + 2.2 + H / 2, rz, rw / 2, H / 2, rd / 2, 0, { walkable: false });
    // The rampart on top is walkable, which is what visitors climb for.
    ctx.collide.box(rx, g + 2.2 + H + 0.45, rz, rw / 2, 0.45, rd / 2, 0, { walkable: true });
  }
  batch.add(M.paving(0x9a938a), box((OUT - WALL) * 2, 0.4, (OUT - WALL) * 2), xform(0, g + 2.4, 0));
  ctx.collide.box(0, g + 2.4, 0, OUT - WALL, 0.2, OUT - WALL, 0, { walkable: true });

  if (detail) {
    // Three tiers of arched gun casemates, all the way round.
    const arch = batch.instances(M.civicStone(0x3a332c), lathe([0, 0, 1.5, 0.5, 1.5, 1.1], 10));
    for (let side = 0; side < 4; side++) {
      const a = (side * Math.PI) / 2;
      const nx = Math.sin(a);
      const nz = Math.cos(a);
      for (let i = 0; i < 8; i++) {
        const t = -OUT + 4.4 + i * ((OUT * 2 - 8.8) / 7);
        for (let tier = 0; tier < 3; tier++) {
          const y = g + 4.6 + tier * 4.4;
          arch.at(xform(nx * (OUT + 0.3) + nz * t, y, nz * (OUT + 0.3) - nx * t, a, Math.PI / 2, 0));
        }
      }
    }
    // The spiral stair turret in one corner.
    batch.add(brickMat, lathe([3.4, g + 2.2, 3.4, g + 2.2 + H + 4], 12), xform(-OUT + 5, 0, OUT - 5));
    // The lighthouse on the rampart — small, and the only thing above the wall.
    batch.add(M.paintedWhite(), lathe([1.5, g + 2.2 + H, 1.2, g + 2.2 + H + 6.5], 10),
      xform(OUT - 5, 0, -OUT + 5));
    batch.add(M.emitter(0xfff0c8, 2.6), lathe([1.4, g + 2.2 + H + 6.5, 1.4, g + 2.2 + H + 8.2], 10),
      xform(OUT - 5, 0, -OUT + 5));
  }
}

export const fortPoint: LandmarkModule = {
  yaw: (def: LandmarkDef) => def.rotation,
  build: buildFortPoint,
  nearRange: (def) => Math.max(700, def.radius * 8),
};

/* ================================================================== *
 * Chase Center
 * ================================================================== */

function buildChaseCenter(ctx: LandmarkCtx): void {
  const { batch, detail } = ctx;
  const g = ctx.originY;
  const glass = M.curtainGlass(0x9db4c6);
  const panel = M.quartzPrecast();
  const roofMat = M.quartzPrecast();

  const R = 68;
  const H = 34;

  /**
   * The drum is METAL PANEL with a glazed concourse band, not a glass cylinder.
   *
   * Built as glass all the way up, an arena has no inside — the far wall shows
   * through the near one and the whole thing reads as an empty hoop rather than
   * as a building. That is also just what Chase Center is: an opaque skin of
   * pale panel above a two-storey ring of glass at the concourse, which is the
   * only level anybody can see into anyway.
   */
  const seg = detail ? 44 : 18;
  /**
   * Every drum here is a `lathe`, not a `loft` between two `circleRing`s.
   *
   * That is not a style preference. `loft` faces its quads according to the
   * winding of the rings it is given, and `circleRing`'s winding puts the
   * normals on the INSIDE — which for an opaque wall is invisible (you see the
   * inside of the far side instead of the outside of the near one, and at a
   * distance the silhouette is identical) and for anything glazed is not: the
   * near wall culls away entirely and the arena reads as an open hoop standing
   * on stilts. `LatheGeometry` sweeps a profile in +X around +Y with outward
   * normals, no winding to get wrong.
   */
  const drum = (y0: number, y1: number, r0: number, r1: number) =>
    lathe([r0, g + y0, r1, g + y1], seg);

  // Concourse glazing, ground to 11 m — with the concourse itself behind it.
  // Glass over nothing is a hole whichever way the normals point.
  batch.add(glass, drum(0.4, 11, R * 0.94, R * 0.985), xform(0, 0, 0));
  batch.add(M.concrete(0x6d6862), drum(0.4, 11, R * 0.86, R * 0.9), xform(0, 0, 0));
  // The panelled body above it, leaning back in at the top.
  batch.add(panel, drum(11, H * 0.62, R * 0.985, R), xform(0, 0, 0));
  batch.add(panel, drum(H * 0.62, H, R, R * 0.97), xform(0, 0, 0));
  // A precast plinth at the base and a cornice ring at the top.
  batch.add(panel, drum(0, 0.6, R * 0.96, R * 0.94), xform(0, 0, 0));
  batch.add(panel, drum(H, H + 1.6, R * 1.02, R * 1.02), xform(0, 0, 0));

  /* ---- the shallow domed roof ---- */
  const roofProfile: number[] = [];
  const rs = detail ? 8 : 4;
  for (let i = 0; i <= rs; i++) {
    const t = i / rs;
    roofProfile.push(R * 0.99 * Math.cos((t * Math.PI) / 2), g + H + 1.6 + Math.sin((t * Math.PI) / 2) * 9);
  }
  batch.add(roofMat, lathe(roofProfile, seg), xform(0, 0, 0));

  ctx.collide.box(0, g + H / 2, 0, R, H / 2, R, 0, { walkable: false });
  ctx.collide.box(0, g + H + 1.8, 0, R * 0.7, 0.4, R * 0.7, 0, { walkable: true });

  if (detail) {
    // Mullions, and the plaza with its ring of trees.
    // Mullions on the panelled body only. Run full height they read as pilotis
    // holding the arena up off the ground, which is the opposite of the truth.
    const mull = batch.instances(M.darkSteel(), box(0.34, H - 11, 0.34));
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      mull.atPos(Math.cos(a) * (R + 0.2), g + 11 + (H - 11) / 2, Math.sin(a) * (R + 0.2), -a);
    }
    batch.add(M.paving(0xb0aa9e), box(230, 0.3, 200), xform(0, g - 0.1, 0));
    const tree = batch.instances(M.foliage(0x51763a), lathe([0, 0, 3.6, 2.6, 2.6, 6.2, 0, 8.4], 6));
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2;
      tree.atPos(Math.cos(a) * (R + 26), g, Math.sin(a) * (R + 24));
    }
  }
}

export const chaseCenter: LandmarkModule = {
  yaw: (def: LandmarkDef) => def.rotation,
  build: buildChaseCenter,
  nearRange: (def) => Math.max(900, def.radius * 9),
};
