/**
 * Oracle Park — the ballpark on China Basin, with McCovey Cove behind the right
 * field wall and the only stadium in baseball where people wait in kayaks for a
 * home run to land in the water.
 *
 * The park is deliberately asymmetric, which is the whole reason it is
 * interesting to model:
 *   left field   103 m foul line, deep power alley, the big scoreboard above
 *   centre field 121 m to the wall, the deepest corner in the majors
 *   right field  94 m — very short, because the bay is right there — and the
 *                7.3 m brick wall with the arcade behind it, so the public can
 *                stand on the promenade and watch the game through the arches
 *                for free. That arcade is the building's signature.
 *
 * The bowl is generated as a lofted sweep with an angle-dependent radius, so
 * one function produces the whole asymmetric plan and the seating tiers follow
 * it automatically.
 */
import * as THREE from "three";
import * as M from "./materials";
import { archedPanel, box, loft, shapedRing, strut, xform } from "./kit";
import { streetYaw, type LandmarkCtx, type LandmarkModule } from "./types";
import type { LandmarkDef } from "../../geo/sfGeo";

/**
 * Distance from the centre of the diamond to the outfield wall at bearing
 * `a` (0 = right field line, increasing toward centre and left).
 */
function wallR(a: number): number {
  // A cardioid-ish blend of the three published distances, which is close
  // enough to the real polygon that fans recognise the shape.
  const rf = 94;
  const cf = 121;
  const lf = 103;
  const t = a / Math.PI; // 0..1 across the outfield
  const w = Math.sin(a);
  return rf * (1 - t) + lf * t + (cf - (rf + lf) / 2) * w * 0.9;
}

const HOME_OFFSET = 46; // home plate sits this far from the bowl centre

function build(ctx: LandmarkCtx): void {
  const { batch, detail, rng } = ctx;
  const g = ctx.originY;
  const brickMat = M.brick(0xbe7a5c);
  const concreteMat = M.concrete(0xc9c3b6);
  const seatMat = M.paintedColour(0x2a4b3f, 1.2);
  const steel = M.paintedColour(0x2f4f45, 1.6);
  const seg = detail ? 72 : 26;

  /** Outfield-wall radius as a function of ring angle. */
  const R = (th: number) => {
    // Map the full circle so the outfield occupies the far half and the
    // backstop the near half.
    const a = ((th % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    if (a <= Math.PI) return wallR(a);
    // Behind the plate the bowl wraps in tight.
    const u = (a - Math.PI) / Math.PI;
    return 62 + 26 * Math.sin(u * Math.PI);
  };

  /* ---------------- playing surface ---------------- */
  const field = shapedRing(g + 0.4, seg, (th) => R(th) - 0.6);
  const hub = shapedRing(g + 0.4, seg, () => 0.4);
  batch.add(M.grass(0x9dbf72), loft([field, hub], false, false));
  ctx.collide.box(0, g + 0.4, 0, 130, 0.4, 130, 0, { walkable: true });

  if (detail) {
    // Infield dirt: the skinned diamond plus the base paths, drawn as a fan
    // around home plate. It is the strongest read from the air.
    const dirt: Float32Array[] = [];
    const hz = -HOME_OFFSET;
    dirt.push(
      shapedRing(g + 0.45, 40, (th) => {
        const d = 29 + 8 * Math.cos(th * 2);
        return d;
      }),
    );
    dirt.push(shapedRing(g + 0.45, 40, () => 0.3));
    const dg = loft(dirt, false, false);
    dg.translate(0, 0, hz + 26);
    batch.add(M.sand(), dg);
    // Pitcher's mound.
    batch.add(M.sand(), new THREE.CylinderGeometry(2.7, 3.0, 0.28, 18), xform(0, g + 0.6, hz + 26 - 4));
    // Mown stripes: alternate light and dark bands across the outfield.
    for (let i = 0; i < 9; i++) {
      const stripe = shapedRing(g + 0.46, seg, (th) => Math.min(R(th) - 1, 24 + i * 11));
      const stripe2 = shapedRing(g + 0.46, seg, (th) => Math.min(R(th) - 1, 18 + i * 11));
      if (i % 2 === 0) batch.add(M.grass(0x8ab066), loft([stripe, stripe2], false, false));
    }
  }

  /* ---------------- outfield wall ---------------- */
  const wallH = 3.4;
  const wallTop = shapedRing(g + wallH, seg, (th) => R(th));
  const wallBot = shapedRing(g + 0.4, seg, (th) => R(th));
  batch.add(M.paintedColour(0x14372c, 1.4), loft([wallBot, wallTop], false, false));

  /* ---------------- the right field brick wall and arcade ---------------- */
  // The tall stretch over McCovey Cove: 7.3 m of brick with arched openings
  // behind it onto the public promenade.
  const rfWallH = 7.3;
  const arcadeStart = 0.06;
  const arcadeEnd = 0.42;
  const rfRings: Float32Array[] = [];
  rfRings.push(
    shapedRing(g + 0.4, seg, (th) => {
      const a = ((th % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      const inArc = a > Math.PI * arcadeStart && a < Math.PI * arcadeEnd;
      return R(th) + (inArc ? 0.4 : 0);
    }),
  );
  rfRings.push(
    shapedRing(g + rfWallH, seg, (th) => {
      const a = ((th % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      const inArc = a > Math.PI * arcadeStart && a < Math.PI * arcadeEnd;
      return inArc ? R(th) + 0.4 : R(th) - 40;
    }),
  );
  batch.add(brickMat, loft(rfRings, false, false));
  if (detail) {
    const arch = archedPanel(6.6, rfWallH + 1.4, 1.1, 3.4, 6.4);
    const arcade = batch.instances(brickMat, arch);
    const n = 22;
    for (let i = 0; i < n; i++) {
      const a = Math.PI * (arcadeStart + ((arcadeEnd - arcadeStart) * i) / (n - 1));
      const r = R(a) + 4.4;
      arcade.atPos(Math.cos(a) * r, g + 0.4, Math.sin(a) * r, -a + Math.PI / 2);
    }
    // Promenade deck behind the arcade.
    const prom: Float32Array[] = [
      shapedRing(g + 0.9, seg, (th) => {
        const a = ((th % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
        return a > Math.PI * arcadeStart && a < Math.PI * arcadeEnd ? R(th) + 1 : R(th);
      }),
      shapedRing(g + 0.9, seg, (th) => {
        const a = ((th % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
        return a > Math.PI * arcadeStart && a < Math.PI * arcadeEnd ? R(th) + 10 : R(th);
      }),
    ];
    batch.add(M.paving(0xb6afa1), loft(prom, false, false));
  }

  /* ---------------- the bowl ---------------- */
  // Three tiers. Each is a sloped sweep from an inner ring to an outer one;
  // the rake gets steeper as you go up, exactly as it does in the real thing.
  const tiers: [number, number, number, number][] = [
    // innerOffset, outerOffset, baseY, topY
    [3, 26, 0.4, 11],
    [22, 46, 13, 27],
    [40, 62, 30, 47],
  ];
  for (let t = 0; t < tiers.length; t++) {
    const [i0, i1, y0, y1] = tiers[t];
    const inner = shapedRing(g + y0, seg, (th) => R(th) + i0);
    const outer = shapedRing(g + y1, seg, (th) => R(th) + i1);
    batch.add(seatMat, loft([inner, outer], false, false));
    // The concrete underside/fascia of the deck above.
    const fasciaTop = shapedRing(g + y1 + 3.2, seg, (th) => R(th) + i1);
    batch.add(concreteMat, loft([outer, fasciaTop], false, false));

    if (detail) {
      // Seat rows: shallow steps swept round the bowl. Two rings per row is
      // enough to catch the light and give the tier its corduroy texture.
      const rows = 9;
      for (let r = 1; r < rows; r++) {
        const f = r / rows;
        const yA = y0 + (y1 - y0) * f;
        const rA = (th: number) => R(th) + i0 + (i1 - i0) * f;
        const a1 = shapedRing(g + yA, seg, rA);
        const a2 = shapedRing(g + yA + 0.55, seg, rA);
        batch.add(t === 1 ? M.paintedColour(0x315748, 1.2) : seatMat, loft([a1, a2], false, false));
      }
    }
  }

  /* ---------------- outer facade ---------------- */
  const facadeH = 30;
  const fOuter = shapedRing(g, seg, (th) => R(th) + 64);
  const fTop = shapedRing(g + facadeH, seg, (th) => R(th) + 64);
  batch.add(brickMat, loft([fOuter, fTop], false, false));
  // Collision is a ring of slabs around the facade, not a solid block: the
  // interior has to stay open so the player can drop into the bowl.
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    const r = R(a) + 64;
    ctx.collide.box(Math.cos(a) * r, g + facadeH / 2, Math.sin(a) * r, 3, facadeH / 2, (Math.PI * 2 * r) / 48, -a, {
      walkable: false,
    });
    ctx.collide.box(Math.cos(a) * (R(a) + 50), g + 49, Math.sin(a) * (R(a) + 50), 14, 1, (Math.PI * 2 * r) / 48, -a, {
      walkable: true,
    });
  }
  if (detail) {
    const arch = archedPanel(9, 16, 1.4, 5, 13);
    const bays = batch.instances(concreteMat, arch);
    const n = 44;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const r = R(a) + 64.6;
      bays.atPos(Math.cos(a) * r, g, Math.sin(a) * r, -a + Math.PI / 2);
    }
    // Cornice and the pennant masts along the roofline.
    const corniceA = shapedRing(g + facadeH, seg, (th) => R(th) + 65.8);
    const corniceB = shapedRing(g + facadeH + 1.8, seg, (th) => R(th) + 64.6);
    batch.add(concreteMat, loft([corniceA, corniceB], false, false));
    const mast = batch.instances(M.brightMetal(0xc0c4c8), box(0.16, 9, 0.16));
    const flag = batch.instances(M.paintedColour(0xd87a2a, 1.0), box(0.06, 1.6, 2.6));
    for (let i = 0; i < 30; i++) {
      const a = (i / 30) * Math.PI * 2;
      const r = R(a) + 64.6;
      mast.atPos(Math.cos(a) * r, g + facadeH + 6.3, Math.sin(a) * r);
      flag.atPos(Math.cos(a) * r, g + facadeH + 9.6, Math.sin(a) * r, -a);
    }
  }

  /* ---------------- light towers ---------------- */
  const towerAngles = [0.35, 0.85, 1.5, 2.15, 2.75, 4.4, 5.3];
  const lampGeo = box(1.1, 1.1, 0.5);
  const lamps = batch.instances(M.emitter(0xfff4d6, 5), lampGeo);
  for (const a of towerAngles) {
    const r = R(a) + 60;
    const px = Math.cos(a) * r;
    const pz = Math.sin(a) * r;
    const top = g + facadeH + 26;
    // Four splayed legs and a lamp rack.
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        batch.add(
          steel,
          box(1, 1, 1),
          strut(px + sx * 3.4, g + facadeH, pz + sz * 3.4, px + sx * 1.4, top - 4, pz + sz * 1.4, 0.55, 0.55),
        );
      }
    }
    batch.add(steel, box(11, 1.2, 4.4), xform(px, top - 3.4, pz, -a));
    for (let row = 0; row < 2; row++) {
      for (let k = -4; k <= 4; k++) {
        lamps.atPos(
          px + Math.cos(-a + Math.PI / 2) * k * 1.15,
          top - 2.4 + row * 1.3,
          pz + Math.sin(-a + Math.PI / 2) * k * 1.15,
          -a,
          -0.5,
        );
      }
    }
    ctx.collide.box(px, g + facadeH + 13, pz, 4, 13, 4, 0, { walkable: false });
  }

  /* ---------------- scoreboard ---------------- */
  const sbA = 2.35;
  const sbR = R(sbA) + 30;
  const sbX = Math.cos(sbA) * sbR;
  const sbZ = Math.sin(sbA) * sbR;
  batch.add(concreteMat, box(46, 16, 4), xform(sbX, g + 40, sbZ, -sbA + Math.PI / 2));
  const boardMat = M.emitter(0x1a2a3a, 1.1);
  batch.add(boardMat, box(44, 14, 0.6), xform(sbX, g + 40, sbZ - 2.4, -sbA + Math.PI / 2));
  ctx.onFrame((t) => {
    // A slow flicker so the board reads as a live display, not a painted panel.
    boardMat.emissiveIntensity = 0.9 + 0.35 * (0.5 + 0.5 * Math.sin(t * 5.1));
  });
  for (const s of [-1, 1]) {
    batch.add(steel, box(3, 34, 3), xform(sbX + s * 22, g + 26, sbZ, -sbA + Math.PI / 2));
  }

  /* ---------------- the roof canopy over the upper deck ---------------- */
  if (detail) {
    const canopyIn = shapedRing(g + 50, seg, (th) => R(th) + 44);
    const canopyOut = shapedRing(g + 47, seg, (th) => R(th) + 66);
    batch.add(concreteMat, loft([canopyIn, canopyOut], false, false));
    const hanger = batch.instances(steel, box(1, 1, 1));
    for (let i = 0; i < 40; i++) {
      const a = (i / 40) * Math.PI * 2;
      hanger.at(
        strut(
          Math.cos(a) * (R(a) + 44),
          g + 50,
          Math.sin(a) * (R(a) + 44),
          Math.cos(a) * (R(a) + 62),
          g + 47,
          Math.sin(a) * (R(a) + 62),
          0.4,
          0.4,
        ),
      );
    }
  }

  /* ---------------- kayaks in McCovey Cove ---------------- */
  if (detail) {
    const kayak = batch.instances(M.paintedColour(0xd8843a, 0.8), box(3.6, 0.35, 0.75));
    const kr = rng.fork("kayaks");
    for (let i = 0; i < 26; i++) {
      const a = Math.PI * kr.range(0.08, 0.4);
      const r = R(a) + 74 + kr.range(4, 62);
      const px = Math.cos(a) * r;
      const pz = Math.sin(a) * r;
      if (ctx.ground(px, pz) > -0.4) continue;
      kayak.atPos(px, 0.16, pz, kr.range(0, Math.PI * 2));
    }
  }
}

export const oraclePark: LandmarkModule = {
  yaw: (def: LandmarkDef) => streetYaw(def.x, def.z, Math.PI / 2),
  build,
  nearRange: (def) => Math.max(900, def.radius * 6),
};
