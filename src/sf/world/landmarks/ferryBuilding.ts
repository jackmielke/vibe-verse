/**
 * The Ferry Building — 1898, and the thing at the foot of Market Street that
 * the whole downtown grid points at.
 *
 * A 200 m arcaded Beaux-Arts shed with a 74 m clock tower stuck in the middle
 * of it, and the tower is explicitly a copy of the Giralda in Seville: a tall
 * blind-arcaded shaft, a clock stage, an open belfry, and a stepped cap. Four
 * clock faces, 6.7 m across, with hands you can read from Market Street.
 *
 * The other half of the landmark is the *rhythm*: the ground floor is a
 * continuous arcade of round-headed arches at 7 m centres for two hundred
 * metres. That relentless repetition is the building's whole character, so the
 * arcade is real geometry — instanced, but real — rather than a texture.
 */
import * as THREE from "three";
import * as M from "./materials";
import { archedPanel, box, cornice, hipRoof, lathe, loft, xform } from "./kit";
import { streetYaw, type LandmarkCtx, type LandmarkModule } from "./types";
import type { LandmarkDef } from "../../geo/sfGeo";

const LEN = 202;
const DEPTH = 34;
const EAVE = 21;
const BAY = 7.05;
const TOWER_W = 12.2;
const TOWER_TOP = 74;

function build(ctx: LandmarkCtx): void {
  const { batch, detail } = ctx;
  const g = ctx.originY;
  const stone = M.civicStone(0xdcd6c6);
  const shade = M.civicStone(0xc2bcac);
  const glass = M.curtainGlass(0x5c6a72);
  const roof = M.roofTile(0x9a8d7d);

  /* ---------------- the shed ---------------- */
  batch.add(stone, box(LEN, EAVE, DEPTH), xform(0, g + EAVE / 2, 0));
  ctx.collide.box(0, g + EAVE / 2, 0, LEN / 2, EAVE / 2, DEPTH / 2, 0, { walkable: false });
  // Arched clerestory roof — the great nave over the ferry concourse.
  batch.add(roof, hipRoof(LEN, DEPTH, 7, 1.1), xform(0, g + EAVE + 1.6, 0));
  batch.add(stone, box(LEN + 2.2, 1.6, DEPTH + 2.2), xform(0, g + EAVE + 0.8, 0));
  ctx.collide.box(0, g + EAVE + 0.8, 0, LEN / 2, 0.8, DEPTH / 2, 0, { walkable: true });

  /* ---------------- the arcade ---------------- */
  const bays = Math.round(LEN / BAY);
  const arch = archedPanel(BAY, 9.6, 1.5, 4.1, 8.2);
  const arcade = batch.instances(stone, arch);
  const arch2 = archedPanel(BAY, 9.6, 1.4, 4.1, 8.2);
  const arcadeBack = batch.instances(shade, arch2);
  const glazing = batch.instances(glass, box(BAY - 2.2, 7.6, 0.3));
  for (let i = 0; i < bays; i++) {
    const x = -LEN / 2 + BAY * (i + 0.5);
    if (Math.abs(x) < TOWER_W * 0.8) continue;
    arcade.atPos(x, g, DEPTH / 2 + 0.6);
    arcadeBack.atPos(x, g, -DEPTH / 2 - 0.6, Math.PI);
    glazing.atPos(x, g + 4.4, DEPTH / 2 - 0.2);
  }

  /* ---------------- upper floors ---------------- */
  if (detail) {
    // Two storeys of round-arched windows over the arcade, then the cornice.
    const win = batch.instances(glass, box(2.3, 3.4, 0.3));
    const surround = batch.instances(shade, archedPanel(3.6, 4.4, 0.4, 2.5, 4.0));
    for (const z of [DEPTH / 2 + 0.16, -DEPTH / 2 - 0.16]) {
      for (let lvl = 0; lvl < 2; lvl++) {
        const y = g + 11.4 + lvl * 4.7;
        for (let i = 0; i < bays; i++) {
          const x = -LEN / 2 + BAY * (i + 0.5);
          if (Math.abs(x) < TOWER_W * 0.8) continue;
          const face = z > 0 ? 0 : Math.PI;
          surround.atPos(x, y - 0.2, z, face);
          win.atPos(x, y + 1.8, z * 0.995, face);
        }
      }
    }
    // Modillion cornice: the deep bracketed eaves that read as a hard black
    // line under the roof from anywhere on the Embarcadero.
    for (const s of [1, -1]) {
      batch.add(
        shade,
        cornice(LEN, [0, EAVE - 2.6, 1.5, EAVE - 1.9, 1.9, EAVE - 0.9, 1.2, EAVE - 0.2, 0.2, EAVE], -0.6),
        xform(0, g, s * (DEPTH / 2 + 0.1), s > 0 ? 0 : Math.PI),
      );
      const brackets = batch.instances(shade, box(0.55, 1.5, 1.6));
      for (let i = 0; i < bays * 2; i++) {
        brackets.atPos(-LEN / 2 + (LEN * (i + 0.5)) / (bays * 2), g + EAVE - 2.2, s * (DEPTH / 2 + 0.9));
      }
    }
  }

  /* ---------------- the clock tower ---------------- */
  const t = TOWER_W / 2;
  // Shaft, with a slight batter — it narrows about 8% over its height.
  const shaftRings: Float32Array[] = [];
  for (const [w, y] of [
    [t * 2.5, 0],
    [t * 2.5, 2],
    [t * 2.15, 4],
    [t * 2.0, EAVE],
    [t * 1.92, 46],
  ] as const) {
    shaftRings.push(
      new Float32Array([
        -w / 2, g + y, -w / 2, w / 2, g + y, -w / 2, w / 2, g + y, w / 2, -w / 2, g + y, w / 2,
      ]),
    );
  }
  batch.add(stone, loft(shaftRings, false, false));
  ctx.collide.box(0, g + TOWER_TOP / 2, 0, t * 1.1, TOWER_TOP / 2, t * 1.1, 0, { walkable: false });

  if (detail) {
    // Giralda blind arcading: paired slender arches recessed into each face,
    // repeated up the shaft. It is the detail that makes it Sevillian.
    const blind = batch.instances(shade, archedPanel(2.4, 6.2, 0.35, 1.5, 5.4));
    for (let lvl = 0; lvl < 5; lvl++) {
      const y = g + EAVE + 1.5 + lvl * 6.6;
      if (y > g + 45) break;
      for (let f = 0; f < 4; f++) {
        const a = (f * Math.PI) / 2;
        const cos = Math.cos(a);
        const sin = Math.sin(a);
        for (const u of [-2.7, 0, 2.7]) {
          blind.atPos(cos * (t * 0.97) - sin * u, y, sin * (t * 0.97) + cos * u, a);
        }
      }
    }
  }

  // Clock stage.
  const clockY = 47;
  batch.add(shade, box(t * 2.3, 9.2, t * 2.3), xform(0, g + clockY + 4.6, 0));
  const faceGeo = new THREE.CylinderGeometry(3.35, 3.35, 0.4, detail ? 28 : 10);
  faceGeo.rotateX(Math.PI / 2);
  const handGeo = box(0.34, 2.5, 0.16);
  const hands = batch.instances(M.civicStone(0x1c1a18), handGeo);
  for (let f = 0; f < 4; f++) {
    const a = (f * Math.PI) / 2;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    batch.add(
      M.emitter(0xf6efdc, 0.9),
      faceGeo,
      xform(cos * (t * 1.18), g + clockY + 4.6, sin * (t * 1.18), a + Math.PI / 2),
    );
    if (!detail) continue;
    // The hands sit just clear of the dial, at 10:10 — the pose every clock in
    // every advertisement holds, because it frames the maker's name.
    hands.at(
      xform(cos * (t * 1.24), g + clockY + 5.6, sin * (t * 1.24), a + Math.PI / 2, 0, -1.05, 1, 1, 1),
    );
    hands.at(
      xform(cos * (t * 1.26), g + clockY + 5.3, sin * (t * 1.26), a + Math.PI / 2, 0, 1.05, 0.8, 0.7, 1),
    );
  }
  faceGeo.dispose();

  // Belfry: open arched stage.
  const belfryY = clockY + 9.6;
  const belfryH = 8.4;
  const pierGeo = box(2.0, belfryH, 2.0);
  const belfry = batch.instances(stone, pierGeo);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      belfry.atPos(sx * (t * 0.92), g + belfryY + belfryH / 2, sz * (t * 0.92));
    }
  }
  batch.add(M.emitter(0xffc27a, 0.7), box(t * 1.5, belfryH - 1, t * 1.5), xform(0, g + belfryY + belfryH / 2, 0));
  batch.add(shade, box(t * 2.35, 1.6, t * 2.35), xform(0, g + belfryY + belfryH + 0.8, 0));

  // Stepped cap and the lantern.
  const capY = belfryY + belfryH + 1.6;
  const capRings: Float32Array[] = [];
  for (const [w, y] of [
    [t * 2.2, capY],
    [t * 1.7, capY + 2.4],
    [t * 1.55, capY + 3.0],
    [t * 1.1, capY + 5.2],
    [t * 0.95, capY + 5.8],
    [t * 0.5, capY + 8.0],
  ] as const) {
    capRings.push(
      new Float32Array([
        -w / 2, g + y, -w / 2, w / 2, g + y, -w / 2, w / 2, g + y, w / 2, -w / 2, g + y, w / 2,
      ]),
    );
  }
  batch.add(stone, loft(capRings, false, true));
  batch.add(
    M.goldLeaf(),
    lathe([0.9, g + capY + 8, 1.5, g + capY + 9.4, 0.9, g + capY + 10.8, 0, g + capY + 12.6], detail ? 16 : 8),
  );
  batch.add(M.goldLeaf(), box(0.18, 3.4, 0.18), xform(0, g + capY + 14.2, 0));

  /* ---------------- the plaza and the pier aprons ---------------- */
  batch.add(M.paving(0xb2aa9c), box(LEN + 26, 0.5, 22), xform(0, g + 0.25, DEPTH / 2 + 11));
  ctx.collide.box(0, g + 0.25, DEPTH / 2 + 11, LEN / 2 + 13, 0.5, 11, 0, { walkable: true });
  if (detail) {
    // Palm row along the Embarcadero — Canary Island date palms, unmistakable.
    const trunk = batch.instances(M.deckTimber(0x9d9080), box(0.7, 1, 0.7));
    const frond = batch.instances(M.foliage(0x6f8452), box(6.6, 0.28, 1.1));
    for (let i = -6; i <= 6; i++) {
      const x = i * 15;
      const h = 9 + ((i * 37) % 5) * 0.4;
      trunk.atPos(x, g + h / 2, DEPTH / 2 + 19, 0, 0, 0, 1, h, 1);
      for (let k = 0; k < 7; k++) {
        const a = (k / 7) * Math.PI * 2;
        frond.atPos(x + Math.cos(a) * 2.4, g + h - 0.4, DEPTH / 2 + 19 + Math.sin(a) * 2.4, -a, 0, -0.42);
      }
    }
  }
}

export const ferryBuilding: LandmarkModule = {
  // The building's long axis runs with the Embarcadero, and its clock faces
  // straight down Market Street — so it takes its orientation from the grid.
  yaw: (def: LandmarkDef) => streetYaw(def.x, def.z, Math.PI / 2),
  build,
  nearRange: (def) => Math.max(900, def.radius * 10),
};
