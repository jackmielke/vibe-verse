/**
 * Coit Tower, on the summit of Telegraph Hill.
 *
 * A 64 m fluted concrete cylinder that Lillie Hitchcock Coit's bequest paid for
 * in 1933, and which the architects always denied was meant to look like a fire
 * hose nozzle. It is unreinforced-looking Art Deco: no ornament except the
 * flutes, a ring of arched observation openings near the top, and a stepped cap.
 *
 * Two details do all the work:
 *  - the **flutes taper with the shaft**, so they converge slightly as they
 *    rise. A cylinder with parallel flutes reads as a factory chimney.
 *  - the shaft **is not plumb-sided**: it loses about a metre of diameter over
 *    its height. That taper is why it looks tall from the base.
 *
 * The tower is also the game's most-used spawn point, so the observation
 * gallery is real geometry you can stand on and step off.
 */
import * as THREE from "three";
import * as M from "./materials";
import { archedPanel, box, flutedCylinder, lathe, loft, shapedRing, stairs, xform } from "./kit";
import { streetYaw, type LandmarkCtx, type LandmarkModule } from "./types";
import type { LandmarkDef } from "../../geo/sfGeo";

const BASE_H = 9;
const SHAFT_TOP = 51;
const GALLERY_TOP = 58;
const CAP_TOP = 64;
const R_BASE = 6.3;
const R_TOP = 5.6;
const FLUTES = 20;

function build(ctx: LandmarkCtx): void {
  const { batch, detail } = ctx;
  const g = ctx.originY;
  const concrete = M.concrete(0xe0dacb);
  const shade = M.concrete(0xcac3b4);

  /* ---------------- Pioneer Park: the plinth the tower stands on ---------- */
  // The summit is a built platform with a retaining wall, not a natural cone.
  const plazaR = 34;
  const plazaRings: Float32Array[] = [];
  const pseg = detail ? 40 : 16;
  for (const [r, y] of [
    [plazaR + 2, -4],
    [plazaR, 0],
    [plazaR, 0.9],
  ] as const) {
    plazaRings.push(shapedRing(g + y, pseg, () => r));
  }
  batch.add(M.paving(0xb7b0a2), loft(plazaRings, false, true));
  ctx.collide.box(0, g + 0.45, 0, plazaR, 0.9, plazaR, 0, { walkable: true });
  if (detail) {
    // Balustrade around the overlook, and the cypress hedge behind it.
    const post = batch.instances(M.civicStone(0xd9d3c6), box(0.4, 1.05, 0.4));
    for (let i = 0; i < 56; i++) {
      const a = (i / 56) * Math.PI * 2;
      post.atPos(Math.cos(a) * (plazaR - 0.7), g + 1.4, Math.sin(a) * (plazaR - 0.7), -a);
    }
    const cap = shapedRing(g + 2.0, pseg, () => plazaR - 0.7);
    const cap2 = shapedRing(g + 2.28, pseg, () => plazaR - 0.7);
    batch.add(M.civicStone(0xe2dccf), loft([cap, cap2], false, false));
  }

  /* ---------------- base pavilion ---------------- */
  batch.add(concrete, box(19, BASE_H, 19), xform(0, g + BASE_H / 2, 0));
  batch.add(shade, box(21, 1.2, 21), xform(0, g + BASE_H + 0.6, 0));
  ctx.collide.box(0, g + BASE_H / 2, 0, 9.5, BASE_H / 2, 9.5, 0, { walkable: false });
  ctx.collide.box(0, g + BASE_H + 0.6, 0, 10.5, 0.6, 10.5, 0, { walkable: true });

  if (detail) {
    // Entrance loggia: three tall openings on the approach side, and the flight
    // of steps up to them.
    for (let i = -1; i <= 1; i++) {
      batch.add(
        M.civicStone(0x33312e),
        archedPanel(4.6, BASE_H - 0.6, 0.5, 2.6, 5.4),
        xform(i * 4.8, g, 9.6),
      );
    }
    batch.add(M.paving(0xc4bdaf), stairs(6, 0.17, 0.36, 12), xform(-9.8, g + 0.9, 10.9, -Math.PI / 2));
  }

  /* ---------------- the fluted shaft ---------------- */
  batch.add(
    concrete,
    flutedCylinder(R_BASE, R_TOP, SHAFT_TOP - BASE_H, FLUTES, 0.42, detail ? 8 : 2, FLUTES * (detail ? 4 : 2)),
    xform(0, g + BASE_H, 0),
  );
  ctx.collide.box(0, g + (BASE_H + SHAFT_TOP) / 2, 0, R_BASE, (SHAFT_TOP - BASE_H) / 2, R_BASE, 0, {
    walkable: false,
  });

  /* ---------------- observation gallery ---------------- */
  // A wider drum with twelve arched openings; the floor of it is walkable and
  // is what a player standing at the "coit" spawn is standing on.
  const galR = R_TOP + 0.9;
  batch.add(shade, lathe([0, g + SHAFT_TOP, galR + 0.5, g + SHAFT_TOP, galR + 0.5, g + SHAFT_TOP + 1, R_TOP, g + SHAFT_TOP + 1], detail ? 32 : 12));
  const piers = detail ? 12 : 6;
  for (let i = 0; i < piers; i++) {
    const a = (i / piers) * Math.PI * 2;
    batch.add(
      concrete,
      box(1.5, GALLERY_TOP - SHAFT_TOP - 1.6, 1.5),
      xform(
        Math.cos(a) * galR,
        g + SHAFT_TOP + 1 + (GALLERY_TOP - SHAFT_TOP - 1.6) / 2,
        Math.sin(a) * galR,
        -a,
      ),
    );
  }
  // Lintel ring over the openings.
  batch.add(
    concrete,
    lathe(
      [
        R_TOP - 0.6, g + GALLERY_TOP - 0.6,
        galR + 0.6, g + GALLERY_TOP - 0.6,
        galR + 0.6, g + GALLERY_TOP + 0.4,
        R_TOP - 0.6, g + GALLERY_TOP + 0.4,
      ],
      detail ? 32 : 12,
    ),
  );
  ctx.collide.box(0, g + SHAFT_TOP + 0.5, 0, galR, 0.6, galR, 0, { walkable: true });

  // A warm interior glow behind the arcade — Coit Tower is lit from inside.
  batch.add(
    M.emitter(0xffc98a, 1.4),
    new THREE.CylinderGeometry(R_TOP - 0.7, R_TOP - 0.7, GALLERY_TOP - SHAFT_TOP - 2, detail ? 20 : 8, 1, true),
    xform(0, g + SHAFT_TOP + 1 + (GALLERY_TOP - SHAFT_TOP - 2) / 2, 0),
  );

  /* ---------------- stepped cap ---------------- */
  const capRings: Float32Array[] = [];
  const cseg = detail ? 28 : 12;
  const steps: [number, number][] = [
    [galR + 0.6, GALLERY_TOP + 0.4],
    [galR + 0.2, GALLERY_TOP + 0.6],
    [R_TOP - 0.2, GALLERY_TOP + 0.9],
    [R_TOP - 0.4, GALLERY_TOP + 2.4],
    [R_TOP - 1.5, GALLERY_TOP + 2.8],
    [R_TOP - 1.7, CAP_TOP - 1.2],
    [R_TOP - 2.9, CAP_TOP - 0.9],
    [1.4, CAP_TOP],
  ];
  for (const [r, y] of steps) capRings.push(shapedRing(g + y, cseg, () => r));
  batch.add(concrete, loft(capRings, false, true));
  ctx.collide.box(0, g + CAP_TOP - 3, 0, R_TOP, 3, R_TOP, 0, { walkable: true });

  // Beacon and flagpole.
  batch.add(M.paintedColour(0xd6d1c6, 0.8), box(0.26, 9, 0.26), xform(0, g + CAP_TOP + 4.5, 0));
  const beaconGeo = new THREE.SphereGeometry(0.5, 8, 6);
  batch.add(M.emitter(0xff3020, 5), beaconGeo, xform(0, g + CAP_TOP + 9.4, 0));
  beaconGeo.dispose();
}

export const coitTower: LandmarkModule = {
  yaw: (def: LandmarkDef) => streetYaw(def.x, def.z, Math.PI / 2),
  build,
  nearRange: (def) => Math.max(900, def.radius * 22),
  anchor: true,
};
