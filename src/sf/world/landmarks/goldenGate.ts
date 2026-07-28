/**
 * The Golden Gate Bridge.
 *
 * 2.7 km of it, at true scale, walkable and drivable end to end. This is the
 * single most-photographed object in the game and the one the player will spend
 * the most time standing on, hanging off and flying under, so it gets modelled
 * from the real drawings rather than from memory:
 *
 *   main span            1280 m between tower centres
 *   side spans            343 m each
 *   tower height          227 m above mean water
 *   deck at midspan        67 m above mean water
 *   main cable diameter  0.92 m, sag ≈ 143 m over the main span
 *   suspender spacing    15.24 m (50 ft)
 *   deck width           27.4 m — which is also the tower leg spacing, because
 *                        the towers *are* the deck's width, and getting that
 *                        relationship right is most of why a model of this
 *                        bridge reads as correct or doesn't
 *
 * The Art Deco detail that matters at 200 m is the tower bracing: five portal
 * struts per tower whose openings have *stepped* heads, and vertical recesses
 * running the full height of each leg that break the mass into ribs. Leave
 * those out and you have a generic suspension bridge; put them in and it is
 * unmistakable from four kilometres away.
 *
 * Colour is `steel-painted`, which the material library bakes as genuine
 * International Orange (0xC0362C) with rivet lines, plate seams, chipped
 * arrises and red-oxide primer bleeding through the wear. It is not a tint.
 */
import * as THREE from "three";
import * as M from "./materials";
import {
  box,
  cableCurve,
  cableY,
  loft,
  mergeAndDispose,
  rectRing,
  ribbon,
  strut,
  taperBox,
  tube,
  xform,
} from "./kit";
import { bearingYaw, type LandmarkCtx, type LandmarkModule } from "./types";
import { latLonToWorld, type LandmarkDef } from "../../geo/sfGeo";

/* ------------------------------------------------------------------ *
 * Dimensions
 * ------------------------------------------------------------------ */

const HALF_MAIN = 640; // tower centre to midspan
const SIDE_SPAN = 343;
const ANCHOR_X = HALF_MAIN + SIDE_SPAN; // 983
const TOWER_TOP = 227;
const SADDLE_Y = 219;
const DECK_MID = 67;
const DECK_TOWER = 64.5;
const DECK_ANCHOR = 55;
const CABLE_LOW = 74; // main cable low point at midspan
const CABLE_HALF_Z = 13.7; // cable / tower leg centreline offset
const ROADWAY_HALF = 9.6; // six lanes
const SIDEWALK_W = 3.1;
const DECK_HALF = ROADWAY_HALF + SIDEWALK_W; // 12.7 m to the outside of the walk
const TRUSS_DEPTH = 7.6;
const SUSPENDER_STEP = 15.24;
const APPROACH_LEN = 640;

/** Scratch rotation, so a 500-member truss does not allocate 500 matrices. */
const ROT = new THREE.Matrix4();

/** Deck elevation at a local X, before the approach ramps take over. */
function deckY(x: number): number {
  const ax = Math.abs(x);
  if (ax <= HALF_MAIN) {
    // Camber: the roadway crests at midspan. Only 2.5 m over 1.3 km, but it is
    // the reason you cannot see the far tower's base from the near one.
    return DECK_TOWER + (DECK_MID - DECK_TOWER) * Math.cos((x / HALF_MAIN) * (Math.PI / 2));
  }
  if (ax <= ANCHOR_X) {
    const t = (ax - HALF_MAIN) / SIDE_SPAN;
    return DECK_TOWER - (DECK_TOWER - DECK_ANCHOR) * t * t;
  }
  return DECK_ANCHOR;
}

/** Main-cable elevation at a local X. */
function cableAt(x: number): number {
  const ax = Math.abs(x);
  if (ax <= HALF_MAIN) {
    const t = (x + HALF_MAIN) / (2 * HALF_MAIN);
    return cableY(SADDLE_Y, SADDLE_Y, SADDLE_Y - CABLE_LOW, t);
  }
  const t = (ax - HALF_MAIN) / SIDE_SPAN;
  // Side span: saddle down to the anchorage, hanging below the chord.
  return cableY(SADDLE_Y, 34, 26, t);
}

/* ------------------------------------------------------------------ *
 * Orientation — taken from the real tower positions, not from a guess
 * ------------------------------------------------------------------ */

const S_TOWER = latLonToWorld(37.8146, -122.4776);
const N_TOWER = latLonToWorld(37.8259, -122.4785);
const BRIDGE_YAW = bearingYaw(S_TOWER.x, S_TOWER.z, N_TOWER.x, N_TOWER.z);

/* ------------------------------------------------------------------ *
 * Tower
 * ------------------------------------------------------------------ */

/** Leg cross-section half-extents at height fraction t (0 = pier, 1 = top). */
function legHalf(t: number): [number, number] {
  // Six stepped stages. Within a stage the leg tapers smoothly; at each stage
  // boundary it steps in, which is what throws the horizontal shadow lines you
  // can read from Marin.
  const stages = 6;
  const s = Math.min(stages - 1, Math.floor(t * stages));
  const step = s * 0.34;
  const hx = 6.7 - 3.1 * t - step * 0.16;
  const hz = 5.2 - 2.4 * t - step * 0.13;
  return [hx, hz];
}

function buildTower(ctx: LandmarkCtx, cx: number): void {
  const { batch, detail } = ctx;
  const orange = M.internationalOrange();
  const deep = M.orangeShadowed();
  const concrete = M.concrete(0xd8d4c9);

  const pierTop = 4.5;
  const rows = detail ? 30 : 8;

  for (const sz of [-CABLE_HALF_Z, CABLE_HALF_Z]) {
    // ---- pier: the tower legs land on a concrete pier that breaks the water
    const [phx, phz] = legHalf(0);
    batch.add(
      concrete,
      taperBox(phx * 2.9, phz * 2.9, phx * 2.3, phz * 2.3, pierTop + 12),
      xform(cx, -12, sz),
    );
    ctx.collide.box(cx, pierTop / 2, sz, phx * 1.3, pierTop / 2 + 9, phz * 1.3);

    // ---- leg: lofted through the stepped profile so the setbacks are real
    // geometry rather than a texture, because they catch the sun edge-on.
    const rings: Float32Array[] = [];
    for (let r = 0; r <= rows; r++) {
      const t = r / rows;
      const [hx, hz] = legHalf(t);
      rings.push(rectRing(hx * 2, hz * 2, pierTop + t * (TOWER_TOP - pierTop)));
    }
    batch.add(orange, loft(rings, true, true), xform(cx, 0, sz));
    ctx.collide.box(
      cx,
      (TOWER_TOP + pierTop) / 2,
      sz,
      legHalf(0.5)[0],
      (TOWER_TOP - pierTop) / 2,
      legHalf(0.5)[1],
      0,
      { walkable: false },
    );

    if (!detail) continue;

    // ---- vertical recesses. Modelled as proud ribs rather than cut channels:
    // identical read in silhouette and shading, a tenth of the geometry.
    const ribGeo = box(0.5, 1, 0.5);
    const ribs = batch.instances(deep, ribGeo);
    const ribRows = 26;
    for (let f = 0; f < 2; f++) {
      for (let k = -1; k <= 1; k++) {
        for (let r = 0; r < ribRows; r++) {
          const t0 = r / ribRows;
          const t1 = (r + 1) / ribRows;
          const [hx, hz] = legHalf((t0 + t1) / 2);
          const y0 = pierTop + t0 * (TOWER_TOP - pierTop);
          const y1 = pierTop + t1 * (TOWER_TOP - pierTop);
          const face = f === 0 ? -1 : 1;
          ribs.atPos(
            cx + k * hx * 0.58,
            (y0 + y1) / 2,
            sz + face * (hz + 0.16),
            0,
            0,
            0,
            hx * 0.5,
            y1 - y0,
            0.42,
          );
          ribs.atPos(
            cx + face * (hx + 0.16),
            (y0 + y1) / 2,
            sz + k * hz * 0.58,
            0,
            0,
            0,
            0.42,
            y1 - y0,
            hz * 0.5,
          );
        }
      }
    }
  }

  // ---- portal struts with stepped Art Deco heads
  const strutY = [16, 40, DECK_MID + 9, 108, 148, 187, 214];
  const gap = CABLE_HALF_Z * 2;
  for (let i = 0; i < strutY.length; i++) {
    const y = strutY[i];
    const t = (y - 4.5) / (TOWER_TOP - 4.5);
    const [hx] = legHalf(t);
    const h = i === 2 ? 5.2 : 4.4 - t * 1.4;
    batch.add(M.internationalOrange(), box(hx * 1.9, h, gap), xform(cx, y + h / 2, 0));
    if (!detail) continue;
    // The stepped soffit: three corbels stepping inwards below the strut.
    for (let k = 0; k < 3; k++) {
      const len = 3.6 - k * 1.0;
      const yy = y - (k + 0.5) * 1.35;
      for (const s of [-1, 1]) {
        batch.add(
          M.orangeShadowed(),
          box(hx * 1.72, 1.35, len),
          xform(cx, yy, s * (gap / 2 - len / 2)),
        );
      }
    }
    // Cross bracing in the X of the portal, above the strut.
    if (i >= 3) {
      const braceLen = Math.hypot(gap, 18);
      const ang = Math.atan2(18, gap);
      for (const s of [-1, 1]) {
        ROT.makeRotationX(s * ang);
        batch.add(
          M.internationalOrange(),
          box(hx * 0.9, 1.1, braceLen),
          xform(cx, y + h + 9, 0).multiply(ROT),
        );
      }
    }
  }

  // ---- saddles: the cast steel shoes the main cable rides over
  for (const sz of [-CABLE_HALF_Z, CABLE_HALF_Z]) {
    batch.add(M.darkSteel(), box(7.4, 3.2, 4.6), xform(cx, SADDLE_Y + 1.2, sz));
  }

  // ---- aircraft warning lights on the tower tops
  const lampMat = M.emitter(0xff2418, 6);
  const lampGeo = new THREE.SphereGeometry(0.85, 10, 8);
  for (const sz of [-CABLE_HALF_Z, CABLE_HALF_Z]) {
    batch.add(lampMat, lampGeo, xform(cx, TOWER_TOP + 1.3, sz));
  }
  lampGeo.dispose();
}

/* ------------------------------------------------------------------ *
 * Deck
 * ------------------------------------------------------------------ */

interface DeckProfile {
  /** Centreline, local space. */
  points: THREE.Vector3[];
  /** Local X of the two viaduct ends. */
  southEnd: number;
  northEnd: number;
}

/**
 * The full centreline including the approach viaducts, which ramp down until
 * they are close enough to the real terrain to land. Sampling `ctx.ground`
 * rather than assuming a height is what keeps the bridge from floating over
 * the Presidio or burying itself in the Marin Headlands.
 */
function deckProfile(ctx: LandmarkCtx): DeckProfile {
  const pts: THREE.Vector3[] = [];
  const step = 16;
  const southEnd = -ANCHOR_X - APPROACH_LEN;
  const northEnd = ANCHOR_X + APPROACH_LEN;
  const southGround = ctx.ground(southEnd, 0);
  const northGround = ctx.ground(northEnd, 0);
  for (let x = southEnd; x <= northEnd + 0.01; x += step) {
    let y: number;
    if (x < -ANCHOR_X) {
      const t = (-ANCHOR_X - x) / APPROACH_LEN;
      const target = Math.max(southGround + 5, 10);
      y = DECK_ANCHOR + (target - DECK_ANCHOR) * (t * t * (3 - 2 * t));
    } else if (x > ANCHOR_X) {
      const t = (x - ANCHOR_X) / APPROACH_LEN;
      const target = Math.max(northGround + 5, 10);
      y = DECK_ANCHOR + (target - DECK_ANCHOR) * (t * t * (3 - 2 * t));
    } else {
      y = deckY(x);
    }
    pts.push(new THREE.Vector3(x, y, 0));
  }
  return { points: pts, southEnd, northEnd };
}

function buildDeck(ctx: LandmarkCtx, profile: DeckProfile): void {
  const { batch, detail } = ctx;
  const pts = profile.points;

  // Roadway + sidewalks. One ribbon each so the sidewalk sits proud of the
  // carriageway with a real kerb line instead of a texture seam.
  batch.add(M.asphalt(), ribbon(pts, ROADWAY_HALF, 0.9));
  const walkPts = pts.map((p) => new THREE.Vector3(p.x, p.y + 0.22, p.z));
  for (const s of [-1, 1]) {
    const off = walkPts.map(
      (p) => new THREE.Vector3(p.x, p.y, p.z + s * (ROADWAY_HALF + SIDEWALK_W / 2)),
    );
    batch.add(M.paving(0xd6d2c6), ribbon(off, SIDEWALK_W / 2, 0.24));
  }

  // Lane markings: two yellow lines down the middle, white lane lines out.
  const lanes = [-6.4, -3.2, 3.2, 6.4];
  for (const o of lanes) {
    const line = pts.map((p) => new THREE.Vector3(p.x, p.y + 0.03, p.z + o));
    batch.add(M.paintedWhite(), ribbon(line, 0.09));
  }
  for (const o of [-0.28, 0.28]) {
    const line = pts.map((p) => new THREE.Vector3(p.x, p.y + 0.03, p.z + o));
    batch.add(M.paintedColour(0xd8a832), ribbon(line, 0.1));
  }

  // The movable median barrier, installed in 2015 — a low steel zipper line.
  batch.add(
    M.darkSteel(),
    ribbon(
      pts.map((p) => new THREE.Vector3(p.x, p.y + 0.75, p.z)),
      0.32,
      0.75,
    ),
  );

  // Drivable/walkable surface for the rest of the game.
  ctx.collide.ribbon(pts, DECK_HALF, 1.2, { drivable: true, walkable: true });

  /* ---- stiffening truss ---- */
  const orange = M.internationalOrange();
  for (const s of [-1, 1]) {
    for (const yOff of [-0.9, -TRUSS_DEPTH]) {
      const chord = pts.map(
        (p) => new THREE.Vector3(p.x, p.y + yOff, p.z + s * (DECK_HALF - 0.6)),
      );
      batch.add(orange, ribbon(chord, 0.6, 0.85));
    }
  }

  // Verticals and diagonals. Instanced: 500-odd identical members.
  const panel = detail ? 11.4 : 45.6;
  const memberGeo = box(0.5, 1, 0.5);
  const members = batch.instances(orange, memberGeo);
  const crossGeo = box(0.6, 0.6, 1);
  const crosses = batch.instances(orange, crossGeo);
  const x0 = profile.southEnd;
  const x1 = profile.northEnd;
  let prevX = x0;
  for (let x = x0; x <= x1; x += panel) {
    const y = deckAtProfile(profile, x);
    for (const s of [-1, 1]) {
      const z = s * (DECK_HALF - 0.6);
      members.atPos(x, y - TRUSS_DEPTH / 2 - 0.45, z, 0, 0, 0, 1, TRUSS_DEPTH - 0.9, 1);
      if (detail && x > x0) {
        // Diagonal across the panel just closed.
        const yPrev = deckAtProfile(profile, prevX);
        members.at(
          strut(prevX, yPrev - 1.35, z, x, y - TRUSS_DEPTH + 0.45, z, 0.42, 0.42),
        );
      }
    }
    // Cross frame under the roadway, tying the two trusses together.
    crosses.atPos(x, y - TRUSS_DEPTH + 0.5, 0, 0, 0, 0, 1, 1, DECK_HALF * 2 - 1.2);
    prevX = x;
  }

  /* ---- railings ---- */
  // The Deco railing: slender posts at close centres with a heavy top rail.
  // Post spacing is what gives the bridge its moiré at speed, so it is modelled
  // rather than faked with a texture.
  const postSpacing = detail ? 3.2 : 32;
  const postGeo = box(0.11, 1.06, 0.11);
  const posts = batch.instances(orange, postGeo);
  for (let x = x0; x <= x1; x += postSpacing) {
    const y = deckAtProfile(profile, x) + 0.22;
    for (const s of [-1, 1]) {
      posts.atPos(x, y + 0.53, s * DECK_HALF);
    }
  }
  for (const s of [-1, 1]) {
    for (const h of [1.12, 0.62]) {
      const rail = pts.map((p) => new THREE.Vector3(p.x, p.y + 0.22 + h, p.z + s * DECK_HALF));
      batch.add(orange, ribbon(rail, 0.09, 0.12));
    }
  }

  /* ---- lamp standards ---- */
  if (detail) {
    const poleGeo = mergeAndDispose([
      (() => {
        const g = box(0.22, 8.6, 0.22);
        g.translate(0, 4.3, 0);
        return g;
      })(),
      (() => {
        const g = box(1.5, 0.18, 0.3);
        g.translate(0.7, 8.6, 0);
        return g;
      })(),
    ]);
    const poles = batch.instances(M.darkSteel(), poleGeo);
    const lampGeo = box(0.9, 0.22, 0.44);
    const lamps = batch.instances(M.emitter(0xffcf8a, 2.6), lampGeo);
    for (let x = x0 + 30; x <= x1; x += 52) {
      const y = deckAtProfile(profile, x) + 0.22;
      for (const s of [-1, 1]) {
        poles.atPos(x, y, s * (DECK_HALF - 0.5), s > 0 ? Math.PI : 0);
        lamps.atPos(x + 0.7 * (s > 0 ? -1 : 1), y + 8.5, s * (DECK_HALF - 0.5));
      }
    }
  }
}

/** Deck elevation at an arbitrary local X, interpolated off the profile. */
function deckAtProfile(p: DeckProfile, x: number): number {
  const step = p.points[1].x - p.points[0].x;
  const f = (x - p.points[0].x) / step;
  const i = Math.max(0, Math.min(p.points.length - 2, Math.floor(f)));
  const t = Math.max(0, Math.min(1, f - i));
  return p.points[i].y + (p.points[i + 1].y - p.points[i].y) * t;
}

/* ------------------------------------------------------------------ *
 * Cables
 * ------------------------------------------------------------------ */

function buildCables(ctx: LandmarkCtx, profile: DeckProfile): void {
  const { batch, detail } = ctx;
  const orange = M.internationalOrange();
  const seg = detail ? 200 : 44;
  const radial = detail ? 10 : 5;

  for (const sz of [-CABLE_HALF_Z, CABLE_HALF_Z]) {
    // One continuous run: anchorage - tower - midspan - tower - anchorage.
    const pts: THREE.Vector3[] = [];
    const n = detail ? 160 : 40;
    for (let i = 0; i <= n; i++) {
      const x = -ANCHOR_X + (2 * ANCHOR_X * i) / n;
      pts.push(new THREE.Vector3(x, cableAt(x), sz));
    }
    batch.add(orange, tube(pts, 0.46, radial, seg));

    // Anchorage tails: the cable dives into the concrete block.
    for (const s of [-1, 1]) {
      const tail = cableCurve(
        s * ANCHOR_X,
        cableAt(s * ANCHOR_X),
        sz,
        s * (ANCHOR_X + 46),
        26,
        sz,
        3,
        8,
      );
      batch.add(orange, tube(tail, 0.46, radial, detail ? 16 : 6));
    }
  }

  /* ---- suspender ropes + cable bands ---- */
  const ropeGeo = new THREE.CylinderGeometry(0.075, 0.075, 1, detail ? 6 : 4, 1, true);
  const ropes = batch.instances(orange, ropeGeo);
  const bandGeo = box(1.05, 0.72, 1.05);
  const bands = detail ? batch.instances(M.darkSteel(), bandGeo) : null;
  const step = detail ? SUSPENDER_STEP : SUSPENDER_STEP * 6;
  for (let x = -ANCHOR_X + 12; x < ANCHOR_X - 12; x += step) {
    const cy = cableAt(x);
    const dy = deckAtProfile(profile, x) + 0.6;
    const len = cy - dy;
    if (len < 1.5) continue;
    for (const sz of [-CABLE_HALF_Z, CABLE_HALF_Z]) {
      ropes.atPos(x, dy + len / 2, sz, 0, 0, 0, 1, len, 1);
      bands?.atPos(x, cy, sz);
    }
  }
  ropeGeo.dispose();
}

/* ------------------------------------------------------------------ *
 * Anchorages, fenders, approach structure
 * ------------------------------------------------------------------ */

function buildAnchorages(ctx: LandmarkCtx, profile: DeckProfile): void {
  const { batch, detail } = ctx;
  const concrete = M.concrete(0xd2cec2);
  for (const s of [-1, 1]) {
    const x = s * (ANCHOR_X + 32);
    const g = ctx.ground(x, 0);
    // A 60 m block of concrete holding 60,000 tonnes of cable tension. It reads
    // as a cliff, and it should: it is the heaviest thing on the bridge.
    batch.add(
      concrete,
      taperBox(64, 52, 52, 42, Math.max(14, 46 - g)),
      xform(x, Math.min(g, 8) - 2, 0),
    );
    ctx.collide.box(x, (Math.min(g, 8) - 2 + 44) / 2, 0, 30, 24, 24);
    if (detail) {
      // Stepped Deco cap and the pylon that frames the roadway.
      batch.add(concrete, box(56, 3.4, 44), xform(x, 45, 0));
      for (const sz of [-1, 1]) {
        batch.add(concrete, taperBox(11, 11, 8, 8, 22), xform(x, 46, sz * 19));
        batch.add(concrete, box(9, 1.6, 9), xform(x, 69, sz * 19));
      }
    }
  }

  // Approach viaduct bents, marching down to the terrain.
  const bentMat = M.internationalOrange();
  const legGeo = box(1.5, 1, 1.5);
  const legs = batch.instances(bentMat, legGeo);
  const capGeo = box(2, 1.4, 1);
  const caps = batch.instances(bentMat, capGeo);
  const spacing = detail ? 34 : 102;
  for (const s of [-1, 1]) {
    for (let d = spacing; d < APPROACH_LEN; d += spacing) {
      const x = s * (ANCHOR_X + d);
      const top = deckAtProfile(profile, x) - TRUSS_DEPTH;
      const g = ctx.ground(x, 0);
      const h = top - g;
      if (h < 3) continue;
      for (const sz of [-1, 1]) {
        legs.atPos(x, g + h / 2, sz * (DECK_HALF - 2), 0, 0, 0, 1, h, 1);
      }
      caps.atPos(x, top - 0.7, 0, 0, 0, 0, 1, 1, DECK_HALF * 2 - 2);
      ctx.collide.box(x, g + h / 2, 0, 1.6, h / 2, DECK_HALF, 0, { walkable: false });
    }
  }

  if (!detail) return;

  /* ---- Fort Point arch ----
   * The south approach vaults over the 1861 brick fort on a steel arch rather
   * than demolishing it. It is a small piece of the bridge that almost nobody
   * models, and it is the first thing you see walking on from the city side. */
  const archX = -ANCHOR_X - 210;
  const span = 96;
  for (const sz of [-1, 1]) {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 20; i++) {
      const t = i / 20;
      const x = archX - span / 2 + span * t;
      const rise = Math.sin(t * Math.PI) * 27;
      pts.push(new THREE.Vector3(x, deckAtProfile(profile, x) - TRUSS_DEPTH - 27 + rise, sz * 9));
    }
    batch.add(bentMat, tube(pts, 1.5, 8, 40));
  }
  // Spandrel posts standing on the arch.
  const spandrel = batch.instances(bentMat, box(0.8, 1, 0.8));
  for (let i = 1; i < 20; i++) {
    const t = i / 20;
    const x = archX - span / 2 + span * t;
    const archY = deckAtProfile(profile, x) - TRUSS_DEPTH - 27 + Math.sin(t * Math.PI) * 27;
    const top = deckAtProfile(profile, x) - TRUSS_DEPTH;
    const h = top - archY;
    if (h < 1) continue;
    for (const sz of [-1, 1]) spandrel.atPos(x, archY + h / 2, sz * 9, 0, 0, 0, 1, h, 1);
  }

  /* ---- south tower fender ----
   * An elliptical concrete cofferdam ring in open water, still there, still
   * taking the tide. It is the only piece of the bridge that touches the bay. */
  const fender: Float32Array[] = [];
  for (const y of [-11, 3.5]) {
    fender.push(
      new Float32Array(
        Array.from({ length: 28 }, (_, i) => {
          const a = (i / 28) * Math.PI * 2;
          return [
            -HALF_MAIN + Math.cos(a) * 47,
            y,
            Math.sin(a) * 28,
          ];
        }).flat(),
      ),
    );
  }
  batch.add(M.concrete(0xb9b3a6), loft(fender, false, true));
}

/* ------------------------------------------------------------------ *
 * Module
 * ------------------------------------------------------------------ */

function build(ctx: LandmarkCtx): void {
  const profile = deckProfile(ctx);
  buildTower(ctx, -HALF_MAIN);
  buildTower(ctx, HALF_MAIN);
  buildDeck(ctx, profile);
  buildCables(ctx, profile);
  buildAnchorages(ctx, profile);

  // A far-LOD-only trick: at 4 km the truss and the ropes are sub-pixel but
  // their *mass* is not, so the silhouette gets a thin solid web under the deck
  // to keep the bridge from thinning into a wire.
  if (!ctx.detail) {
    ctx.batch.add(
      M.internationalOrange(),
      ribbon(
        profile.points.map((p) => new THREE.Vector3(p.x, p.y - TRUSS_DEPTH / 2, p.z)),
        DECK_HALF * 0.55,
        TRUSS_DEPTH * 0.6,
      ),
    );
  }
}

export const goldenGateBridge: LandmarkModule = {
  yaw: (_def: LandmarkDef) => BRIDGE_YAW,
  build,
  nearRange: () => 2600,
  anchor: true,
};

/** Exposed so the traffic system can path vehicles across the bridge. */
export function goldenGateDeckPoints(): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let x = -ANCHOR_X; x <= ANCHOR_X; x += 40) out.push({ x, y: deckY(x) });
  return out;
}

/** Local-space geometry constants other systems occasionally want. */
export const GOLDEN_GATE = {
  yaw: BRIDGE_YAW,
  halfMainSpan: HALF_MAIN,
  anchorX: ANCHOR_X,
  towerTop: TOWER_TOP,
  deckHalfWidth: DECK_HALF,
  deckY,
  cableAt,
} as const;

