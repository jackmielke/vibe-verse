/**
 * Three waterfront-and-edge-of-town landmarks. They share a file because they
 * share a construction problem — everything here either stands in water or
 * stands in sand, and all three read from a long way off as a distinctive
 * skeleton rather than as a mass.
 *
 *   Pier 39         A 1978 shopping pier built from the salvaged timber of the
 *                   pier it replaced: two rows of two-storey shops down a
 *                   central promenade, a carousel at the end, marinas either
 *                   side, and the sea lions that took over K-Dock in 1989 and
 *                   never left.
 *   Shipyard cranes The Pier 70 gantries — sixty metres of riveted steel on
 *                   rails, the last physical trace of the yard that built
 *                   warships here for a century.
 *   Dutch Windmill  The 1902 windmill at the northwest corner of Golden Gate
 *                   Park, built to pump the groundwater that turned sand dunes
 *                   into a park. Four sails, 34 m across, and they turn.
 */
import * as THREE from "three";
import * as M from "./materials";
import {
  box,
  gableRoof,
  lathe,
  loft,
  shapedRing,
  strut,
  taperBoxCyl,
  xform,
} from "./kit";
import { streetYaw, type LandmarkCtx, type LandmarkModule } from "./types";
import { terrainHeight, type LandmarkDef } from "../../geo/sfGeo";

/**
 * Pick the grid axis that points out into open water.
 *
 * A pier that runs inland is a very obvious bug, and which way "out" is depends
 * on the traced coastline, not on a bearing. So probe the terrain solver 250 m
 * down each of the four grid axes and take the deepest.
 */
function seawardYaw(def: LandmarkDef, probe = 250): number {
  const base = streetYaw(def.x, def.z, 0);
  let best = base;
  let deepest = Infinity;
  for (let k = 0; k < 4; k++) {
    const a = base + (k * Math.PI) / 2;
    const h = terrainHeight(def.x + Math.cos(a) * probe, def.z - Math.sin(a) * probe);
    if (h < deepest) {
      deepest = h;
      best = a;
    }
  }
  return best;
}

/* ================================================================== *
 * Pier 39
 * ================================================================== */

const PIER_LEN = 300;
const PIER_W = 76;
const DECK_Y = 4.4;
const PROMENADE = 17;

function buildPier39(ctx: LandmarkCtx): void {
  const { batch, detail, rng } = ctx;
  const deckMat = M.deckTimber(0xb0a189);
  const pileMat = M.deckTimber(0x6b6053);
  const roofMat = M.roofTile(0x8f8b82);
  const x0 = -PIER_LEN * 0.35;
  const x1 = PIER_LEN * 0.65;

  /* ---------------- deck and piles ---------------- */
  batch.add(deckMat, box(x1 - x0, 0.9, PIER_W), xform((x0 + x1) / 2, DECK_Y - 0.45, 0));
  ctx.collide.box((x0 + x1) / 2, DECK_Y - 0.45, 0, (x1 - x0) / 2, 0.6, PIER_W / 2, 0, {
    drivable: true,
    walkable: true,
  });
  const piles = batch.instances(pileMat, box(0.6, 1, 0.6));
  const step = detail ? 9 : 27;
  for (let x = x0 + 4; x < x1; x += step) {
    for (let z = -PIER_W / 2 + 4; z <= PIER_W / 2 - 4; z += step) {
      const bed = Math.min(ctx.ground(x, z), DECK_Y - 3);
      piles.atPos(x, (bed + DECK_Y) / 2, z, 0, 0, 0, 1, DECK_Y - bed, 1);
    }
  }
  if (detail) {
    // Cross-bracing between pile bents, visible from a boat underneath.
    const brace = batch.instances(pileMat, box(1, 1, 1));
    for (let x = x0 + 4; x < x1; x += step * 2) {
      const bed = Math.min(ctx.ground(x, 0), DECK_Y - 3);
      for (let z = -PIER_W / 2 + 4; z < PIER_W / 2 - 4; z += step) {
        brace.at(strut(x, bed + 1, z, x, DECK_Y - 1, z + step, 0.32, 0.32));
        brace.at(strut(x, DECK_Y - 1, z, x, bed + 1, z + step, 0.32, 0.32));
      }
    }
  }

  /* ---------------- the two rows of shops ---------------- */
  // Same shed, forty times, in a palette of weathered marine paint. The variety
  // is in colour, height and roof pitch, exactly as it is on the real pier.
  const shopRng = rng.fork("shops");
  const palette = [0xd8cfbb, 0xc0cbc4, 0xd9c2a6, 0xb9c6cf, 0xcfbfae, 0xc8d0c0];
  const bays = detail ? 13 : 5;
  // Hoisted: one bucket for every balcony rail on the pier, not one per shop.
  const shopRail = batch.instances(M.darkSteel(), box(0.06, 1.0, 0.06));
  for (const s of [-1, 1]) {
    for (let i = 0; i < bays; i++) {
      const w = (x1 - x0 - 30) / bays;
      const cx = x0 + 16 + w * (i + 0.5);
      const cz = s * (PROMENADE / 2 + 11);
      const h = shopRng.range(7.4, 9.6);
      const col = palette[shopRng.int(0, palette.length - 1)];
      batch.add(M.clapboard(col), box(w - 0.6, h, 20), xform(cx, DECK_Y + h / 2, cz));
      batch.add(roofMat, gableRoof(w - 0.6, 20, shopRng.range(2.4, 3.6), 0.5), xform(cx, DECK_Y + h, cz, Math.PI / 2));
      ctx.collide.box(cx, DECK_Y + h / 2, cz, (w - 0.6) / 2, h / 2, 10, 0, { walkable: false });
      ctx.collide.box(cx, DECK_Y + h + 1, cz, (w - 0.6) / 2, 0.5, 10, 0, { walkable: true });
      if (!detail) continue;
      // Shopfront glazing, an awning, and the upper-storey balcony rail.
      batch.add(M.curtainGlass(0x4c5a60), box(w - 3, 3.2, 0.3), xform(cx, DECK_Y + 2.1, cz - s * 10.1));
      batch.add(
        M.paintedColour(shopRng.pick([0xa8443a, 0x2f5f74, 0x2d6b4a, 0xc08a2a]), 1.0),
        box(w - 2, 0.16, 2.4),
        xform(cx, DECK_Y + 4.1, cz - s * 11.2, 0, 0.22),
      );
      for (let k = 0; k < 6; k++) {
        shopRail.atPos(cx - (w - 2) / 2 + ((w - 2) * k) / 5, DECK_Y + 5.4, cz - s * 10.4);
      }
      batch.add(M.emitter(0xffd9a4, 2.2), box(1.8, 0.5, 0.1), xform(cx, DECK_Y + 3.9, cz - s * 10.3));
    }
  }

  /* ---------------- promenade, carousel, banners ---------------- */
  batch.add(M.deckTimber(0xc0b298), box(x1 - x0 - 24, 0.14, PROMENADE), xform((x0 + x1) / 2, DECK_Y + 0.07, 0));
  if (detail) {
    const mast = batch.instances(M.brightMetal(0xbfc3c6), box(0.14, 8, 0.14));
    const banner = batch.instances(M.paintedColour(0xc4442e, 0.9), box(0.05, 2.6, 1.4));
    for (let i = 0; i < 12; i++) {
      const x = x0 + 22 + ((x1 - x0 - 44) * i) / 11;
      for (const s of [-1, 1]) {
        mast.atPos(x, DECK_Y + 4, s * (PROMENADE / 2 - 0.6));
        banner.atPos(x, DECK_Y + 6.4, s * (PROMENADE / 2 - 0.6));
      }
    }
  }
  // Carousel pavilion at the seaward end.
  const cx = x1 - 20;
  batch.add(M.paintedColour(0xefe6d2, 1.2), taperBoxCyl(11, 11, 7.5, detail ? 20 : 8, DECK_Y), xform(cx, 0, 0));
  batch.add(M.roofTile(0xb04a3a), lathe([12.4, DECK_Y + 7.5, 10, DECK_Y + 11, 5, DECK_Y + 13.4, 0, DECK_Y + 15], detail ? 20 : 8), xform(cx, 0, 0));
  const flagGeo = new THREE.SphereGeometry(0.6, 8, 6);
  batch.add(M.goldLeaf(), flagGeo, xform(cx, DECK_Y + 15.6, 0));
  flagGeo.dispose();
  ctx.collide.box(cx, DECK_Y + 4, 0, 11, 4, 11, 0, { walkable: false });
  if (detail) {
    const post = batch.instances(M.brightMetal(0xc8a44e), box(0.12, 4.6, 0.12));
    const horse = batch.instances(M.paintedColour(0xe2d3bc, 0.8), box(1.5, 1.1, 0.5));
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      post.atPos(cx + Math.cos(a) * 8, DECK_Y + 2.3, Math.sin(a) * 8);
      horse.atPos(cx + Math.cos(a) * 8, DECK_Y + 1.9, Math.sin(a) * 8, -a);
    }
  }

  /* ---------------- marina and the sea lion floats ---------------- */
  if (detail) {
    const floatMat = M.deckTimber(0x9d9488);
    const floats = batch.instances(floatMat, box(26, 0.45, 2.6));
    const fingers = batch.instances(floatMat, box(2.4, 0.4, 10));
    const hull = batch.instances(M.paintedColour(0xe4e1d8, 1.0), box(8.4, 1.5, 2.6));
    const mast = batch.instances(M.brightMetal(0xbec2c6), box(0.12, 12, 0.12));
    const sealion = batch.instances(M.paintedColour(0x6d5c4b, 0.7), box(2.1, 0.7, 0.85));
    const mr = rng.fork("marina");
    for (const s of [-1, 1]) {
      for (let d = 0; d < 3; d++) {
        const dz = s * (PIER_W / 2 + 14 + d * 16);
        const dx = x0 + 40 + d * 24;
        floats.atPos(dx, 0.35, dz);
        for (let f = 0; f < 7; f++) {
          const fx = dx - 12 + f * 4;
          fingers.atPos(fx, 0.3, dz + s * 6.2);
          // Half the berths hold a boat; the rest are empty, as they always are.
          if (!mr.chance(0.55)) continue;
          hull.atPos(fx + 2, 0.75, dz + s * 6.4, Math.PI / 2, 0, 0);
          if (mr.chance(0.45)) mast.atPos(fx + 2, 6.6, dz + s * 6.4);
        }
      }
      // K-Dock: the floats the sea lions took over, and the sea lions on them.
      const kz = s * (PIER_W / 2 + 12);
      for (let k = 0; k < 5; k++) {
        const kx = x0 + 20 + k * 13;
        floats.atPos(kx, 0.3, kz, 0, 0, 0, 0.42, 1, 3.2);
        const n = mr.int(3, 7);
        for (let i = 0; i < n; i++) {
          sealion.atPos(
            kx + mr.range(-4.4, 4.4),
            0.85,
            kz + mr.range(-3.6, 3.6),
            mr.range(0, Math.PI * 2),
            mr.range(-0.1, 0.25),
            0,
            mr.range(0.8, 1.25),
          );
        }
      }
    }
  }
}

/* ================================================================== *
 * Shipyard cranes
 * ================================================================== */

function buildCranes(ctx: LandmarkCtx): void {
  const { batch, detail } = ctx;
  const rusted = M.weatheredSteel();
  const painted = M.paintedColour(0xa04a32, 1.8);
  const dark = M.darkSteel();

  const RAIL = 34; // gauge between the rail lines
  const H = 52;

  // Rails the cranes run on, cast into the quay.
  batch.add(M.concrete(0xb5afa2), box(210, 1.0, RAIL + 16), xform(0, ctx.ground(0, 0) + 0.5, 0));
  for (const s of [-1, 1]) {
    batch.add(M.brightMetal(0x8d9195), box(210, 0.18, 0.14), xform(0, ctx.ground(0, 0) + 1.05, s * (RAIL / 2)));
  }

  const legs = batch.instances(painted, box(1, 1, 1));
  for (let c = 0; c < 3; c++) {
    const cx = -70 + c * 70;
    const g = ctx.ground(cx, 0);
    // A-frame legs: splayed at the rails, meeting under the portal beam.
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        legs.at(strut(cx + sx * 7, g + 2, sz * (RAIL / 2), cx + sx * 2.4, g + H * 0.72, sz * (RAIL / 2 - 6), 1.5, 1.5));
      }
      if (detail) {
        for (const sz of [-1, 1]) {
          for (let k = 0; k < 5; k++) {
            const t0 = 0.1 + k * 0.13;
            const t1 = t0 + 0.13;
            const p = (t: number) => [
              cx + sx * (7 - 4.6 * t),
              g + 2 + (H * 0.72 - 2) * t,
              sz * (RAIL / 2 - 6 * t),
            ];
            const a = p(t0);
            const b = p(t1);
            legs.at(strut(a[0], a[1], -a[2], b[0], b[1], b[2], 0.55, 0.55));
          }
        }
      }
    }
    // Portal beam and the machinery house.
    batch.add(painted, box(20, 3.2, RAIL + 4), xform(cx, g + H * 0.74, 0));
    batch.add(M.galvanised(), box(13, 6.5, 11), xform(cx - 6, g + H * 0.74 + 4.8, 0));
    // Tower above the portal, then the boom out over the water.
    batch.add(painted, box(6.5, H * 0.3, 8), xform(cx, g + H * 0.88, 0));
    const boomLen = 62;
    batch.add(painted, box(boomLen, 2.6, 4.4), xform(cx + boomLen / 2 - 4, g + H - 2, 0, 0, -0.16));
    // Counterweight jib and the block.
    batch.add(painted, box(22, 2.2, 4), xform(cx - 13, g + H - 4.5, 0, 0, 0.1));
    batch.add(rusted, box(7, 5, 6), xform(cx - 23, g + H - 6.6, 0));
    if (detail) {
      // Tie-back cables from the tower head to both jibs.
      for (const [ex, ey] of [
        [cx + boomLen - 6, g + H + 5.6],
        [cx - 23, g + H - 3],
      ] as const) {
        batch.add(dark, box(1, 1, 1), strut(cx, g + H * 1.02, 0, ex, ey, 0, 0.22, 0.22));
      }
      // Hoist rope and hook.
      const hookX = cx + boomLen * 0.55;
      batch.add(dark, box(0.16, H * 0.5, 0.16), xform(hookX, g + H - 4 - H * 0.25, 0));
      batch.add(rusted, box(1.6, 2.2, 1.2), xform(hookX, g + H - 4 - H * 0.5, 0));
      // Ladders and the operator's cab.
      batch.add(M.chainlink(), box(1.2, H * 0.7, 0.06), xform(cx + 2.4, g + H * 0.37, RAIL / 2 - 3));
      batch.add(M.curtainGlass(0x44525a), box(3.4, 2.8, 3.2), xform(cx + 4, g + H * 0.74 + 2.4, 6));
    }
    ctx.collide.box(cx, g + H * 0.5, 0, 8, H * 0.5, RAIL / 2 + 2, 0, { walkable: false });
    ctx.collide.box(cx + boomLen / 2 - 4, g + H - 2, 0, boomLen / 2, 1.6, 2.4, 0, { walkable: true });
  }
}

/* ================================================================== *
 * Dutch Windmill
 * ================================================================== */

const MILL_BASE_R = 6.4;
const MILL_TOP_R = 4.2;
const MILL_H = 15.5;
const SAIL_R = 17;

function buildWindmill(ctx: LandmarkCtx): void {
  const { batch, detail, rng } = ctx;
  const g = ctx.originY;
  const shingle = M.roofTile(0x6f6152);
  const trim = M.clapboard(0xe6e0d2);
  const capMat = M.roofTile(0x5a5044);
  const seg = detail ? 24 : 10;

  /* ---- the tower: a shingled truncated cone on a stone plinth ---- */
  batch.add(M.civicStone(0xb9b2a2), lathe([MILL_BASE_R + 1.6, g, MILL_BASE_R + 1.6, g + 1.1, MILL_BASE_R + 0.3, g + 1.4], seg));
  batch.add(shingle, taperBoxCyl(MILL_BASE_R, MILL_TOP_R, MILL_H, seg, g + 1.4), xform(0, 0, 0));
  ctx.collide.box(0, g + MILL_H / 2, 0, MILL_BASE_R, MILL_H / 2 + 1, MILL_BASE_R, 0, { walkable: false });

  if (detail) {
    // Gallery balcony halfway up, on brackets, with a plank rail.
    const galY = g + 8.2;
    const galR = MILL_BASE_R - (MILL_BASE_R - MILL_TOP_R) * ((galY - g - 1.4) / MILL_H) + 1.7;
    batch.add(trim, lathe([galR - 1.9, galY, galR, galY + 0.2, galR, galY + 0.35, galR - 1.9, galY + 0.35], seg));
    const railPost = batch.instances(trim, box(0.11, 1.0, 0.11));
    for (let i = 0; i < 20; i++) {
      const a = (i / 20) * Math.PI * 2;
      railPost.atPos(Math.cos(a) * (galR - 0.2), galY + 0.85, Math.sin(a) * (galR - 0.2), -a);
    }
    batch.add(trim, lathe([galR - 0.35, galY + 1.32, galR - 0.05, galY + 1.32, galR - 0.05, galY + 1.45, galR - 0.35, galY + 1.45], seg));
    const bracket = batch.instances(trim, box(1, 1, 1));
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      bracket.at(
        strut(
          Math.cos(a) * (galR - 2.2), galY - 1.9, Math.sin(a) * (galR - 2.2),
          Math.cos(a) * galR, galY, Math.sin(a) * galR,
          0.22, 0.22,
        ),
      );
    }
    // Windows and the door.
    const win = batch.instances(M.curtainGlass(0x40505a), box(0.9, 1.4, 0.3));
    for (let f = 0; f < 3; f++) {
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + f * 0.4;
        const y = g + 3.4 + f * 4.2;
        const r = MILL_BASE_R - (MILL_BASE_R - MILL_TOP_R) * ((y - g - 1.4) / MILL_H);
        win.atPos(Math.cos(a) * r, y, Math.sin(a) * r, -a);
      }
    }
    batch.add(M.deckTimber(0x6a5a48), box(1.7, 2.6, 0.3), xform(MILL_BASE_R * 0.99, g + 2.7, 0));
  }

  /* ---- the cap: an onion-shaped hood that yaws into the wind ---- */
  const capY = g + 1.4 + MILL_H;
  batch.add(capMat, lathe(
    [
      MILL_TOP_R + 0.5, capY,
      MILL_TOP_R + 0.7, capY + 0.6,
      MILL_TOP_R + 0.3, capY + 2.6,
      MILL_TOP_R - 1.2, capY + 4.4,
      MILL_TOP_R - 2.6, capY + 5.2,
      0, capY + 5.9,
    ],
    seg,
  ));
  // The tail pole that points the cap downwind.
  batch.add(M.deckTimber(0x7c6c58), box(1, 1, 1), strut(-1, capY + 3.4, 0, -13, g + 6.5, 0, 0.35, 0.35));
  batch.add(M.deckTimber(0x8b7a63), box(3.4, 2.6, 0.2), xform(-11.5, g + 7.6, 0));

  /* ---- the sails ---- */
  // Four lattice stocks on a windshaft that leans about 8 degrees, which is why
  // the sails clear the tower. They turn: slowly, and always.
  const hubX = MILL_TOP_R + 1.6;
  const hubY = capY + 2.4;
  // Local frame: the batch's parent group is already at the landmark anchor
  // with the module's yaw applied, so the sails only need their offset on the
  // windshaft plus the 8-degree shaft rake that keeps them clear of the tower.
  const sails = new THREE.Group();
  sails.position.set(hubX, hubY, 0);
  sails.rotation.z = -0.14;
  sails.name = "windmill/sails";

  const stockMat = M.clapboard(0xdcd4c2);
  const slatMat = M.clapboard(0xc4bba6);
  const stockGeo = box(0.42, SAIL_R, 0.42);
  const stockMesh = new THREE.InstancedMesh(stockGeo, stockMat, 4);
  const barGeo = box(0.16, 0.16, 2.4);
  const barMesh = new THREE.InstancedMesh(barGeo, slatMat, 4 * 9);
  const m = new THREE.Matrix4();
  let bi = 0;
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    m.makeRotationX(a);
    const t = new THREE.Matrix4().makeTranslation(0, SAIL_R / 2, 0);
    stockMesh.setMatrixAt(i, m.clone().multiply(t));
    for (let k = 1; k <= 9; k++) {
      const r = (SAIL_R * k) / 10;
      const len = 2.6 * (1 - k / 14);
      const tt = new THREE.Matrix4().makeTranslation(0, r, len / 2 + 0.2);
      const sc = new THREE.Matrix4().makeScale(1, 1, len / 2.4);
      barMesh.setMatrixAt(bi++, m.clone().multiply(tt).multiply(sc));
    }
  }
  stockMesh.instanceMatrix.needsUpdate = true;
  barMesh.instanceMatrix.needsUpdate = true;
  stockMesh.castShadow = true;
  barMesh.castShadow = true;
  sails.add(stockMesh, barMesh);

  // The hub and the windshaft.
  batch.add(M.darkSteel(), new THREE.CylinderGeometry(0.7, 0.7, 3.2, 10).rotateZ(Math.PI / 2), xform(hubX - 0.6, hubY, 0));

  // Hand the rotating group to the streamer through the batch's parent. The
  // sails are the only moving geometry in the landmark layer, and one radian
  // every eleven seconds is about right for a light Ocean Beach breeze.
  ctx.onFrame((t) => {
    sails.rotation.x = t * 0.09 * Math.PI * 2;
  });
  ctx.batch.attach(sails);

  /* ---- the tulip garden ---- */
  const gardenR = 34;
  const bedRings: Float32Array[] = [
    shapedRing(g + 0.35, seg * 2, () => gardenR),
    shapedRing(g + 0.35, seg * 2, () => 8),
  ];
  batch.add(M.grass(0xbfcf8e), loft(bedRings, false, false));
  if (detail) {
    const bloom = batch.instances(M.foliage(0xd85a4a), box(1, 1, 1));
    const bloom2 = batch.instances(M.foliage(0xe8c24a), box(1, 1, 1));
    const gr = rng.fork("tulips");
    for (let ring = 0; ring < 5; ring++) {
      const r = 11 + ring * 4.6;
      const n = Math.round(r * 2.4);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + ring * 0.2;
        const px = Math.cos(a) * r;
        const pz = Math.sin(a) * r;
        const b = ring % 2 === 0 ? bloom : bloom2;
        b.atPos(px, ctx.ground(px, pz) + 0.35, pz, gr.range(0, 3.14), 0, 0, 1.5, 0.55, 1.5);
      }
    }
    // Cypress windbreak behind the mill.
    const trunk = batch.instances(M.deckTimber(0x6f6455), box(1, 1, 1));
    const canopy = batch.instances(M.foliage(0x46603a), box(1, 0.1, 1));
    for (let i = 0; i < 14; i++) {
      const a = Math.PI * 0.55 + (i / 14) * Math.PI * 0.9;
      const r = gardenR + 9;
      const px = Math.cos(a) * r;
      const pz = Math.sin(a) * r;
      const gy = ctx.ground(px, pz);
      const h = gr.range(10, 16);
      trunk.atPos(px, gy + h / 2, pz, 0, 0, 0, 0.5, h, 0.5);
      for (let k = 0; k < 3; k++) {
        canopy.atPos(px, gy + h * 0.72 + k * 1.5, pz, (k / 3) * Math.PI, 0, 0, 5.5 - k, 1, 5.5 - k);
      }
    }
  }
}

/* ================================================================== *
 * Modules
 * ================================================================== */

export const pier39: LandmarkModule = {
  yaw: seawardYaw,
  build: buildPier39,
  nearRange: (def) => Math.max(700, def.radius * 6),
};

export const shipyardCranes: LandmarkModule = {
  yaw: (def: LandmarkDef) => streetYaw(def.x, def.z, 0),
  build: buildCranes,
  nearRange: (def) => Math.max(900, def.radius * 12),
};

export const windmill: LandmarkModule = {
  // The cap faces the prevailing westerly off Ocean Beach.
  yaw: (_def: LandmarkDef) => Math.PI,
  build: buildWindmill,
  nearRange: (def) => Math.max(420, def.radius * 14),
};
