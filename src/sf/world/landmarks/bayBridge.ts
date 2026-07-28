/**
 * The San Francisco–Oakland Bay Bridge.
 *
 * Three completely different structures pretending to be one bridge, which is
 * exactly what makes it interesting to model and what most game versions get
 * wrong by rendering a single generic span:
 *
 *   west crossing   Two suspension bridges *back to back*, sharing a central
 *                   anchorage the size of a city block. Steel lattice towers,
 *                   silver-grey, and a double-deck roadway — upper deck west,
 *                   lower deck east — carried in a deep truss.
 *   Yerba Buena     The traffic vanishes into a tunnel through the island. The
 *                   portal is a concrete Deco frame with the two decks stacked
 *                   in it, and it is the one place you can stand and see the
 *                   whole west crossing framed as a picture.
 *   east span       The 2013 self-anchored suspension bridge: one 160 m white
 *                   tower of four slender shafts tied by shear links, one cable
 *                   that loops over the top and anchors into the deck itself,
 *                   and then the skyway marching off toward Oakland on piers.
 *
 * The far end runs past the playable boundary on purpose. A bridge that stops
 * at a world edge reads as a set; a bridge that keeps going reads as a city
 * that continues past the map.
 */
import * as THREE from "three";
import * as M from "./materials";
import { box, cableY, loft, rectRing, ribbon, strut, taperBox, tube, xform } from "./kit";
import { bearingYaw, type LandmarkCtx, type LandmarkModule } from "./types";
import { latLonToWorld, type LandmarkDef } from "../../geo/sfGeo";

/* ------------------------------------------------------------------ *
 * Layout, in the bridge's local frame (+X = toward Oakland)
 * ------------------------------------------------------------------ */

const SF_ANCHOR = latLonToWorld(37.7908, -122.3878);
const YBI_WEST = latLonToWorld(37.809, -122.3695);
const BRIDGE_YAW = bearingYaw(SF_ANCHOR.x, SF_ANCHOR.z, YBI_WEST.x, YBI_WEST.z);
const WEST_HALF = 1294; // SF anchorage -> central anchorage
const SIDE = 400; // anchorage -> tower
const TOWER_X = WEST_HALF - SIDE; // 894, main span half-length is the same
const TOWER_TOP = 158;
const SADDLE = 150;
const UPPER = 66; // upper deck at the central anchorage
const DECK_GAP = 8.6; // vertical clear between the two decks
const DECK_HALF = 12.2;
const CABLE_Z = 11.6;

const PORTAL_X = WEST_HALF + 90; // west face of the Yerba Buena tunnel
const EAST_PORTAL_X = PORTAL_X + 175;
const SAS_TOWER_X = EAST_PORTAL_X + 190;
const SAS_EAST_X = SAS_TOWER_X + 385;
const SKYWAY_END_X = SAS_EAST_X + 2100;

const ROT = new THREE.Matrix4();

/** Upper-deck elevation at a local X across the whole crossing. */
function deckY(x: number): number {
  if (x <= WEST_HALF) {
    const ax = Math.abs(x);
    if (ax >= TOWER_X) {
      // Side span: ramps down toward the shore anchorages.
      const t = (ax - TOWER_X) / SIDE;
      return UPPER - 2 - 14 * t * t;
    }
    // Main spans crown a little between tower and central anchorage.
    const t = ax / TOWER_X;
    return UPPER - 2 + 2 * Math.sin((1 - t) * Math.PI);
  }
  if (x <= EAST_PORTAL_X) return UPPER + 2; // through the island
  if (x <= SAS_EAST_X) {
    const t = (x - EAST_PORTAL_X) / (SAS_EAST_X - EAST_PORTAL_X);
    return UPPER + 2 - 6 * t;
  }
  const t = (x - SAS_EAST_X) / (SKYWAY_END_X - SAS_EAST_X);
  return UPPER - 4 - 22 * t;
}

/** Main-cable elevation on the west crossing. */
function westCableY(x: number): number {
  const ax = Math.abs(x);
  if (ax <= TOWER_X) {
    const t = (ax / TOWER_X + 1) / 2;
    return cableY(SADDLE, SADDLE, SADDLE - 82, t);
  }
  const t = (ax - TOWER_X) / SIDE;
  return cableY(SADDLE, 44, 22, t);
}

/* ------------------------------------------------------------------ *
 * West crossing
 * ------------------------------------------------------------------ */

/**
 * A steel lattice tower: two braced planes of two legs each, cross-tied.
 * The west-crossing towers are not slab pylons — they are visibly *open*, and
 * that transparency is most of what distinguishes this bridge from the Golden
 * Gate at a distance.
 */
function latticeTower(ctx: LandmarkCtx, cx: number): void {
  const { batch, detail } = ctx;
  const steel = M.bridgeSilver();
  const dark = M.darkSteel();

  const base = 2;
  const legGeo = box(1, 1, 1);
  const legs = batch.instances(steel, legGeo);
  const braceGeo = box(1, 0.8, 0.8);
  const braces = batch.instances(steel, braceGeo);
  const rows = detail ? 12 : 4;

  // Pier below the waterline.
  for (const sz of [-CABLE_Z, CABLE_Z]) {
    batch.add(M.concrete(0xcfcabd), taperBox(23, 17, 17, 13, 20), xform(cx, -14, sz));
  }
  ctx.collide.box(cx, TOWER_TOP / 2, 0, 9, TOWER_TOP / 2, CABLE_Z + 5, 0, { walkable: false });

  const legX = (t: number) => 7.2 - 4.2 * t;
  const legHalf = (t: number) => 1.9 - 0.85 * t;

  for (const sz of [-CABLE_Z, CABLE_Z]) {
    for (const sx of [-1, 1]) {
      for (let r = 0; r < rows; r++) {
        const t0 = r / rows;
        const t1 = (r + 1) / rows;
        const y0 = base + t0 * (TOWER_TOP - base);
        const y1 = base + t1 * (TOWER_TOP - base);
        const tm = (t0 + t1) / 2;
        legs.atPos(
          cx + sx * legX(tm),
          (y0 + y1) / 2,
          sz,
          0,
          0,
          0,
          legHalf(tm) * 2,
          y1 - y0,
          legHalf(tm) * 2,
        );
      }
      if (!detail) continue;
    }
    // X-bracing in the plane of the two legs.
    if (detail) {
      for (let r = 0; r < rows; r++) {
        const t0 = r / rows;
        const t1 = (r + 1) / rows;
        const y0 = base + t0 * (TOWER_TOP - base);
        const y1 = base + t1 * (TOWER_TOP - base);
        const w = legX((t0 + t1) / 2) * 2;
        const h = y1 - y0;
        const len = Math.hypot(w, h);
        const ang = Math.atan2(h, w);
        for (const s of [-1, 1]) {
          ROT.makeRotationZ(s * ang);
          batch.add(steel, box(len, 0.5, 0.5), xform(cx, (y0 + y1) / 2, sz).multiply(ROT));
        }
        braces.atPos(cx, y1, sz, 0, 0, 0, w, 0.7, 1.2);
      }
    }
  }

  // Cross struts tying the two planes together, and the cable saddles.
  for (const y of [30, 62, 96, 126, TOWER_TOP - 4]) {
    batch.add(steel, box(4.4, 2.6, CABLE_Z * 2), xform(cx, y, 0));
    if (detail) {
      const len = Math.hypot(CABLE_Z * 2, 30);
      const ang = Math.atan2(30, CABLE_Z * 2);
      for (const s of [-1, 1]) {
        ROT.makeRotationX(s * ang);
        batch.add(steel, box(2.2, 0.6, len), xform(cx, y + 15, 0).multiply(ROT));
      }
    }
  }
  for (const sz of [-CABLE_Z, CABLE_Z]) {
    batch.add(dark, box(5.4, 2.6, 3.8), xform(cx, SADDLE + 1.3, sz));
  }
  const lamp = new THREE.SphereGeometry(0.7, 8, 6);
  for (const sz of [-CABLE_Z, CABLE_Z]) {
    batch.add(M.emitter(0xff2418, 6), lamp, xform(cx, TOWER_TOP + 1, sz));
  }
  lamp.dispose();
}

function westCrossing(ctx: LandmarkCtx): void {
  const { batch, detail } = ctx;
  const steel = M.bridgeSilver();

  latticeTower(ctx, -TOWER_X);
  latticeTower(ctx, TOWER_X);

  /* ---- decks ---- */
  const upper: THREE.Vector3[] = [];
  const lower: THREE.Vector3[] = [];
  for (let x = -WEST_HALF; x <= WEST_HALF; x += 20) {
    const y = deckY(x);
    upper.push(new THREE.Vector3(x, y, 0));
    lower.push(new THREE.Vector3(x, y - DECK_GAP, 0));
  }
  for (const pts of [upper, lower]) {
    batch.add(M.asphalt(), ribbon(pts, DECK_HALF - 0.8, 0.7));
    ctx.collide.ribbon(pts, DECK_HALF - 0.8, 1.0, { drivable: true, walkable: true });
    for (const o of [-8, -4, 4, 8]) {
      batch.add(
        M.paintedWhite(),
        ribbon(
          pts.map((p) => new THREE.Vector3(p.x, p.y + 0.03, p.z + o)),
          0.09,
        ),
      );
    }
  }

  /* ---- truss between the decks ---- */
  for (const s of [-1, 1]) {
    for (const yOff of [-0.9, -DECK_GAP - 0.6]) {
      batch.add(
        steel,
        ribbon(
          upper.map((p) => new THREE.Vector3(p.x, p.y + yOff, p.z + s * (DECK_HALF - 0.5))),
          0.55,
          0.9,
        ),
      );
    }
  }
  const memberGeo = box(0.5, 1, 0.5);
  const members = batch.instances(steel, memberGeo);
  const panel = detail ? 11.6 : 46;
  let prevX = -WEST_HALF;
  for (let x = -WEST_HALF; x <= WEST_HALF; x += panel) {
    const y = deckY(x);
    for (const s of [-1, 1]) {
      const z = s * (DECK_HALF - 0.5);
      members.atPos(x, y - DECK_GAP / 2, z, 0, 0, 0, 1, DECK_GAP - 1.4, 1);
      if (detail && x > -WEST_HALF) {
        const yPrev = deckY(prevX);
        members.at(
          strut(prevX, yPrev - 1.1, z, x, y - DECK_GAP + 0.7, z, 0.42, 0.42),
        );
      }
    }
    prevX = x;
  }
  // Guard rail on the upper deck.
  for (const s of [-1, 1]) {
    batch.add(
      steel,
      ribbon(
        upper.map((p) => new THREE.Vector3(p.x, p.y + 1.05, p.z + s * DECK_HALF)),
        0.1,
        0.14,
      ),
    );
  }

  /* ---- main cables + suspenders ---- */
  for (const sz of [-CABLE_Z, CABLE_Z]) {
    const pts: THREE.Vector3[] = [];
    const n = detail ? 120 : 32;
    for (let i = 0; i <= n; i++) {
      const x = -WEST_HALF + (2 * WEST_HALF * i) / n;
      pts.push(new THREE.Vector3(x, westCableY(x), sz));
    }
    batch.add(steel, tube(pts, 0.36, detail ? 8 : 5, detail ? 160 : 40));
  }
  const ropeGeo = new THREE.CylinderGeometry(0.06, 0.06, 1, detail ? 5 : 3, 1, true);
  const ropes = batch.instances(steel, ropeGeo);
  const step = detail ? 12 : 70;
  for (let x = -WEST_HALF + 20; x < WEST_HALF - 20; x += step) {
    const cy = westCableY(x);
    const dy = deckY(x) + 0.6;
    const len = cy - dy;
    if (len < 1.5) continue;
    for (const sz of [-CABLE_Z, CABLE_Z]) ropes.atPos(x, dy + len / 2, sz, 0, 0, 0, 1, len, 1);
  }
  ropeGeo.dispose();

  /* ---- central anchorage ----
   * The biggest single mass of concrete in the bay: it takes the pull of four
   * cables from two directions and does nothing else. */
  const g = ctx.ground(0, 0);
  batch.add(M.concrete(0xcbc6ba), taperBox(58, 44, 44, 34, 84 - Math.min(g, -6)), xform(0, Math.min(g, -6), 0));
  batch.add(M.concrete(0xd3cec2), box(48, 4, 38), xform(0, 82, 0));
  ctx.collide.box(0, 40, 0, 26, 44, 20, 0, { walkable: false });

  /* ---- shore anchorages ---- */
  for (const s of [-1, 1]) {
    const x = s * (WEST_HALF + 30);
    const gy = ctx.ground(x, 0);
    batch.add(M.concrete(0xc9c3b6), taperBox(52, 44, 42, 36, Math.max(20, 46 - gy)), xform(x, Math.min(gy, 2) - 4, 0));
  }
}

/* ------------------------------------------------------------------ *
 * Yerba Buena tunnel portal
 * ------------------------------------------------------------------ */

function tunnelPortal(ctx: LandmarkCtx): void {
  const { batch, detail } = ctx;
  const stone = M.concrete(0xd6d0c1);
  const y = deckY(PORTAL_X);

  // The portal face is assembled from jambs, lintels and flanking pylons
  // rather than punched out of a slab. No CSG, no degenerate triangles, and
  // every piece is a real construction element with its own shadow line.
  for (const x of [PORTAL_X, EAST_PORTAL_X]) {
    const openW = 21;
    const upperSill = y - 0.6;
    const lowerSill = y - DECK_GAP - 0.6;
    const openH = 7.2;
    for (const sill of [upperSill, lowerSill]) {
      // Jambs.
      for (const s of [-1, 1]) {
        batch.add(stone, box(3.6, openH, 6), xform(x, sill + openH / 2, s * (openW / 2 + 3)));
      }
      // Lintel with a shallow segmental head.
      batch.add(stone, box(3.6, 2.2, openW + 12), xform(x, sill + openH + 1.1, 0));
    }
    // Deco pylons flanking the whole portal.
    if (detail) {
      for (const s of [-1, 1]) {
        batch.add(stone, taperBox(5, 5, 3.6, 3.6, 22), xform(x, upperSill + 8, s * 19));
        batch.add(stone, box(4.2, 1.2, 4.2), xform(x, upperSill + 30.6, s * 19));
      }
      batch.add(stone, box(3.4, 3, 44), xform(x, upperSill + 10.6, 0));
    }
  }

  // The tunnel bore itself: a dark barrel the roadway disappears into.
  const bore = new THREE.CylinderGeometry(11, 11, EAST_PORTAL_X - PORTAL_X, 16, 1, true, 0, Math.PI);
  bore.rotateZ(Math.PI / 2);
  batch.add(M.concrete(0x6a6660), bore, xform((PORTAL_X + EAST_PORTAL_X) / 2, y - DECK_GAP - 2, 0));
  bore.dispose();

  const through: THREE.Vector3[] = [];
  for (let x = PORTAL_X - 40; x <= EAST_PORTAL_X + 40; x += 20) {
    through.push(new THREE.Vector3(x, deckY(x), 0));
  }
  batch.add(M.asphalt(), ribbon(through, DECK_HALF - 0.8, 0.7));
  batch.add(
    M.asphalt(),
    ribbon(
      through.map((p) => new THREE.Vector3(p.x, p.y - DECK_GAP, p.z)),
      DECK_HALF - 0.8,
      0.7,
    ),
  );
  ctx.collide.ribbon(through, DECK_HALF, 1.0, { drivable: true, walkable: true });
}

/* ------------------------------------------------------------------ *
 * East span: the self-anchored suspension bridge + the skyway
 * ------------------------------------------------------------------ */

function eastSpan(ctx: LandmarkCtx): void {
  const { batch, detail } = ctx;
  const white = M.paintedWhite();

  /* ---- deck: two side-by-side box girders with a slot between them ---- */
  const pts: THREE.Vector3[] = [];
  for (let x = EAST_PORTAL_X; x <= SKYWAY_END_X; x += 24) {
    pts.push(new THREE.Vector3(x, deckY(x), 0));
  }
  for (const s of [-1, 1]) {
    const gird = pts.map((p) => new THREE.Vector3(p.x, p.y, p.z + s * 8.5));
    batch.add(M.asphalt(), ribbon(gird, 7.4, 0.6));
    batch.add(M.concrete(0xbfbab0), ribbon(
      gird.map((p) => new THREE.Vector3(p.x, p.y - 0.7, p.z)),
      7.6,
      3.4,
    ));
    batch.add(white, ribbon(
      gird.map((p) => new THREE.Vector3(p.x, p.y + 1.1, p.z + s * 7.4)),
      0.12,
      0.16,
    ));
    ctx.collide.ribbon(gird, 7.4, 1.0, { drivable: true, walkable: true });
  }

  /* ---- the tower: four shafts tied by shear links ---- */
  const tx = SAS_TOWER_X;
  const shaftGap = 4.6;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const rings: Float32Array[] = [];
      const rows = detail ? 10 : 3;
      for (let r = 0; r <= rows; r++) {
        const t = r / rows;
        const w = 3.6 - 1.5 * t;
        // The four shafts lean together as they rise — barely, but enough that
        // the tower reads as a single tapering object rather than four posts.
        const lean = 1 - t * 0.42;
        rings.push(
          rectRing(w, w, deckY(tx) - 6 + t * (TOWER_TOP + 4)),
        );
        const ring = rings[rings.length - 1];
        for (let i = 0; i < 4; i++) {
          ring[i * 3] += sx * shaftGap * lean;
          ring[i * 3 + 2] += sz * shaftGap * lean;
        }
      }
      batch.add(white, loft(rings, true, true), xform(tx, 0, 0));
    }
  }
  // Shear links: the short steel fuses between the shafts, the whole point of
  // the design — they are meant to be the part that breaks in an earthquake.
  const links = batch.instances(M.bridgeSilver(), box(1, 1.6, 1));
  const nLinks = detail ? 18 : 6;
  for (let i = 1; i <= nLinks; i++) {
    const t = i / (nLinks + 1);
    const y = deckY(tx) - 6 + t * (TOWER_TOP + 4);
    const lean = 1 - t * 0.42;
    for (const s of [-1, 1]) {
      links.atPos(tx + s * shaftGap * lean, y, 0, 0, 0, 0, 2.2, 1, shaftGap * 2 * lean);
      links.atPos(tx, y, s * shaftGap * lean, 0, 0, 0, shaftGap * 2 * lean, 1, 2.2);
    }
  }
  const lamp = new THREE.SphereGeometry(0.7, 8, 6);
  batch.add(M.emitter(0xff2418, 6), lamp, xform(tx, TOWER_TOP + 2, 0));
  lamp.dispose();
  ctx.collide.box(tx, deckY(tx) + TOWER_TOP / 2, 0, 9, TOWER_TOP / 2, 9, 0, { walkable: false });

  /* ---- the single looping cable ----
   * Self-anchored: it terminates in the deck, not in a hillside. So it runs
   * from the east deck end, over the saddle, down the back span, and ties into
   * the deck again just past the tunnel portal. */
  const saddleY = deckY(tx) + TOWER_TOP - 6;
  const runs: [number, number, number][] = [
    [SAS_EAST_X, deckY(SAS_EAST_X) + 2, 62],
    [EAST_PORTAL_X + 20, deckY(EAST_PORTAL_X) + 2, 22],
  ];
  for (const [endX, endY, sag] of runs) {
    const n = detail ? 40 : 12;
    const pts2: THREE.Vector3[] = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      pts2.push(
        new THREE.Vector3(
          tx + (endX - tx) * t,
          cableY(saddleY, endY, sag, t),
          0,
        ),
      );
    }
    batch.add(white, tube(pts2, 0.4, detail ? 8 : 5, detail ? 48 : 14));

    // Suspenders fan out to both girders.
    const ropeGeo = new THREE.CylinderGeometry(0.055, 0.055, 1, 4, 1, true);
    const ropes = batch.instances(M.bridgeSilver(), ropeGeo);
    const count = detail ? 24 : 6;
    for (let i = 1; i < count; i++) {
      const t = i / count;
      const x = tx + (endX - tx) * t;
      const cy = cableY(saddleY, endY, sag, t);
      const dy = deckY(x) + 1;
      const len = cy - dy;
      if (len < 2) continue;
      for (const s of [-1, 1]) {
        ropes.at(strut(x, cy, 0, x, dy, s * 8.5, 0.11, 0.11));
      }
    }
    ropeGeo.dispose();
  }

  /* ---- skyway piers ---- */
  const pierGeo = box(3.4, 1, 3.4);
  const piers = batch.instances(M.concrete(0xc4bfb4), pierGeo);
  const capGeo = box(5, 2.4, 26);
  const caps = batch.instances(M.concrete(0xccc7bb), capGeo);
  const spacing = detail ? 96 : 288;
  for (let x = SAS_EAST_X + spacing; x < SKYWAY_END_X; x += spacing) {
    const y = deckY(x) - 4.2;
    const g = Math.min(ctx.ground(x, 0), -4);
    const h = y - g;
    for (const s of [-1, 1]) piers.atPos(x, g + h / 2, s * 8.5, 0, 0, 0, 1, h, 1);
    caps.atPos(x, y - 1.2, 0);
  }
}

/* ------------------------------------------------------------------ *
 * Module
 * ------------------------------------------------------------------ */

function build(ctx: LandmarkCtx): void {
  westCrossing(ctx);
  tunnelPortal(ctx);
  eastSpan(ctx);
}

export const bayBridge: LandmarkModule = {
  yaw: (_def: LandmarkDef) => BRIDGE_YAW,
  build,
  nearRange: () => 2400,
  anchor: true,
};

export const BAY_BRIDGE = {
  yaw: BRIDGE_YAW,
  westHalf: WEST_HALF,
  deckY,
  deckHalfWidth: DECK_HALF,
  upperDeckGap: DECK_GAP,
} as const;
