/**
 * Alcatraz Island — the Rock.
 *
 * A 9-hectare sandstone lump 2 km off Fisherman's Wharf with a lighthouse, a
 * cellhouse, a burnt-out warden's house and a water tower on it. Everything
 * here is placed against the island polygon in `sfGeo` rather than at made-up
 * offsets, so if the coastline is ever retraced the buildings move with it and
 * nothing ends up standing in the bay.
 *
 * What has to be right for it to read from the city at 3 km:
 *  - the **cliff line**. The island is a cliff on every side; the terrain solver
 *    gives a shore ramp, and this adds the rock escarpment on top of it.
 *  - the **stack**: cellhouse long and low along the ridge, lighthouse and
 *    water tower breaking above it. That three-object skyline is the whole
 *    recognisable shape.
 *  - the **white**. The cellhouse and lighthouse are painted a pale grey-white
 *    that catches the sun; against the dark rock they are what you actually
 *    see from Aquatic Park.
 */
import * as THREE from "three";
import * as M from "./materials";
import { box, gableRoof, hipRoof, lathe, loft, stairs, strut, taperBoxCyl, xform } from "./kit";
import { type LandmarkCtx, type LandmarkModule } from "./types";
import { LANDMASSES, type LandmarkDef } from "../../geo/sfGeo";

const ISLAND = LANDMASSES.find((l) => l.name === "Alcatraz")!;

/** Long axis of the island polygon — everything on the Rock lines up with it. */
function islandAxis(): number {
  let bestD = 0;
  let ang = 0;
  for (let i = 0; i < ISLAND.ring.length; i++) {
    for (let j = i + 1; j < ISLAND.ring.length; j++) {
      const dx = ISLAND.ring[j].x - ISLAND.ring[i].x;
      const dz = ISLAND.ring[j].z - ISLAND.ring[i].z;
      const d = dx * dx + dz * dz;
      if (d > bestD) {
        bestD = d;
        ang = Math.atan2(-dz, dx);
      }
    }
  }
  return ang;
}

const AXIS = islandAxis();

/** Catmull-Rom resample of the island ring, inset toward the centre. */
function ringLocal(ctx: LandmarkCtx, inset: number, samples: number): { x: number; z: number }[] {
  const src = ISLAND.ring.map((p) => ({
    x: ctx.localX(p.x, p.z),
    z: ctx.localZ(p.x, p.z),
  }));
  let cx = 0;
  let cz = 0;
  for (const p of src) {
    cx += p.x;
    cz += p.z;
  }
  cx /= src.length;
  cz /= src.length;
  const n = src.length;
  const out: { x: number; z: number }[] = [];
  for (let i = 0; i < samples; i++) {
    const f = (i / samples) * n;
    const i1 = Math.floor(f);
    const t = f - i1;
    const p0 = src[(i1 - 1 + n) % n];
    const p1 = src[i1 % n];
    const p2 = src[(i1 + 1) % n];
    const p3 = src[(i1 + 2) % n];
    // Uniform Catmull-Rom: the five-point polygon is far too angular to read as
    // a sea cliff, and smoothing it costs nothing at build time.
    const t2 = t * t;
    const t3 = t2 * t;
    const h = (a: number, b: number, c: number, d: number) =>
      0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
    let x = h(p0.x, p1.x, p2.x, p3.x);
    let z = h(p0.z, p1.z, p2.z, p3.z);
    const dx = x - cx;
    const dz = z - cz;
    const len = Math.hypot(dx, dz) || 1;
    x -= (dx / len) * inset;
    z -= (dz / len) * inset;
    out.push({ x, z });
  }
  return out;
}

function build(ctx: LandmarkCtx): void {
  const { batch, detail, rng } = ctx;
  const white = M.paintedMasonry(0xd6d2c6);
  const grimy = M.paintedMasonry(0xa9a396);
  const rock = M.concrete(0x9c8f7c);
  const roofMat = M.roofTile(0x7a746b);
  const steel = M.weatheredSteel();

  /* ================= the cliffs ================= */
  const samples = detail ? 64 : 24;
  const outerR = ringLocal(ctx, 2, samples);
  const innerR = ringLocal(ctx, 26, samples);
  const toe = new Float32Array(samples * 3);
  const brow = new Float32Array(samples * 3);
  const shoulder = new Float32Array(samples * 3);
  for (let i = 0; i < samples; i++) {
    const o = outerR[i];
    const n = innerR[i];
    // Rough the brow line up and down so the escarpment is not a lathe.
    const jag = Math.sin(i * 2.7) * 1.5 + Math.sin(i * 0.9) * 2.6;
    toe[i * 3] = o.x;
    toe[i * 3 + 1] = -7;
    toe[i * 3 + 2] = o.z;
    brow[i * 3] = o.x * 0.985;
    brow[i * 3 + 1] = Math.max(1.5, ctx.ground(o.x, o.z) + 1.5 + jag * 0.4);
    brow[i * 3 + 2] = o.z * 0.985;
    shoulder[i * 3] = n.x;
    shoulder[i * 3 + 1] = ctx.ground(n.x, n.z) + 0.4 + jag * 0.25;
    shoulder[i * 3 + 2] = n.z;
  }
  batch.add(rock, loft([toe, brow, shoulder], false, false));

  /* ================= the plateau buildings ================= */
  /* ---- cellhouse: 130 m of concrete along the ridge ---- */
  const cellW = 128;
  const cellD = 26;
  const cellH = 14.5;
  const cellY = ctx.ground(0, 0);
  batch.add(grimy, box(cellW + 4, 3.4, cellD + 5), xform(0, cellY + 1.2, 0));
  batch.add(white, box(cellW, cellH, cellD), xform(0, cellY + 2.9 + cellH / 2, 0));
  batch.add(roofMat, gableRoof(cellW, cellD, 4.2, 0.9), xform(0, cellY + 2.9 + cellH, 0));
  ctx.collide.box(0, cellY + 2.9 + cellH / 2, 0, cellW / 2, cellH / 2 + 1.7, cellD / 2, 0, { walkable: false });
  ctx.collide.box(0, cellY + 2.9 + cellH + 2.2, 0, cellW / 2, 0.6, cellD / 2, 0, { walkable: true });

  if (detail) {
    // Three tiers of barred windows. The bars are what make it a prison rather
    // than a warehouse, so they are geometry, not a texture.
    const opening = batch.instances(M.civicStone(0x2b2a27), box(1.6, 3.2, 0.4));
    const barGeo = box(0.07, 3.1, 0.07);
    const bars = batch.instances(steel, barGeo);
    for (let f = 0; f < 3; f++) {
      const y = cellY + 4.8 + f * 4.4;
      for (let i = 0; i < 30; i++) {
        const x = -cellW / 2 + 3 + i * 4.2;
        for (const s of [-1, 1]) {
          opening.atPos(x, y, s * (cellD / 2 - 0.05));
          for (let b = -2; b <= 2; b++) bars.atPos(x + b * 0.34, y, s * (cellD / 2 + 0.06));
        }
      }
    }
    // The administration block and the entrance stair on the south face.
    batch.add(white, box(22, cellH + 5, 14), xform(-cellW / 2 + 14, cellY + 2.9 + (cellH + 5) / 2, cellD / 2 + 5));
    batch.add(roofMat, hipRoof(23, 15, 3.4, 0.7), xform(-cellW / 2 + 14, cellY + 2.9 + cellH + 5, cellD / 2 + 5));
    batch.add(M.paving(0xb1a999), stairs(12, 0.17, 0.35, 6), xform(-cellW / 2 + 14, cellY, cellD / 2 + 16.6, -Math.PI / 2));
    // Roof vents and the exercise-yard wall.
    const vent = batch.instances(steel, box(1.1, 1.4, 1.1));
    for (let i = 0; i < 12; i++) vent.atPos(-cellW / 2 + 8 + i * 10, cellY + 2.9 + cellH + 4.6, 0);
    batch.add(grimy, box(52, 6.5, 1.2), xform(cellW / 2 - 26, cellY + 3.2, -cellD / 2 - 22));
    for (const s of [-1, 1]) {
      batch.add(grimy, box(1.2, 6.5, 22), xform(cellW / 2 - 26 + s * 26, cellY + 3.2, -cellD / 2 - 11));
    }
    batch.add(M.paving(0x9d968a), box(50, 0.3, 21), xform(cellW / 2 - 26, cellY + 0.3, -cellD / 2 - 11));
  }

  /* ---- lighthouse ---- */
  const lx = -cellW / 2 - 14;
  const lz = cellD / 2 + 6;
  const lg = ctx.ground(lx, lz);
  batch.add(white, box(16, 7, 11), xform(lx, lg + 3.5, lz + 5));
  batch.add(roofMat, gableRoof(16, 11, 2.6, 0.6), xform(lx, lg + 7, lz + 5));
  const towerH = 25;
  batch.add(white, taperBoxCyl(2.6, 2.1, towerH, detail ? 20 : 8, lg), xform(lx, 0, lz));
  // Gallery, lantern room and the lens.
  batch.add(M.darkSteel(), lathe([2.1, lg + towerH, 3.2, lg + towerH + 0.2, 3.2, lg + towerH + 1.1, 2.1, lg + towerH + 1.2], detail ? 16 : 8), xform(lx, 0, lz));
  const lensMat = M.emitter(0xfff0c8, 8);
  batch.add(
    lensMat,
    new THREE.CylinderGeometry(1.5, 1.5, 2.6, detail ? 14 : 8),
    xform(lx, lg + towerH + 2.4, lz),
  );
  batch.add(M.paintedColour(0xa8362c, 1.2), lathe([2.0, lg + towerH + 3.7, 1.9, lg + towerH + 4.2, 0.9, lg + towerH + 5.4, 0, lg + towerH + 6.0], detail ? 14 : 6), xform(lx, 0, lz));
  ctx.collide.box(lx, lg + towerH / 2, lz, 2.6, towerH / 2, 2.6, 0, { walkable: false });
  // The light sweeps. Two revolutions a minute, like the real one.
  ctx.onFrame((t) => {
    lensMat.emissiveIntensity = 2.5 + 7 * Math.pow(0.5 + 0.5 * Math.cos(t * 0.42), 8);
  });

  /* ---- water tower ---- */
  const wx = cellW / 2 + 22;
  const wz = -6;
  const wg = ctx.ground(wx, wz);
  const legs = batch.instances(steel, box(0.5, 1, 0.5));
  const legH = 20;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      // Splayed legs: 5 m at the base closing to 3 m under the tank.
      legs.at(strut(wx + sx * 5, wg, wz + sz * 5, wx + sx * 3, wg + legH, wz + sz * 3, 0.5, 0.5));
    }
  }
  if (detail) {
    const brace = batch.instances(steel, box(1, 0.24, 0.24));
    for (const y of [6, 12, 17]) {
      const s = 5 - (y / legH) * 2;
      for (let f = 0; f < 4; f++) {
        const a = (f * Math.PI) / 2 + Math.PI / 4;
        brace.atPos(wx + Math.cos(a) * s * 1.414 * 0, wg + y, wz, 0, 0, 0, 1, 1, 1);
      }
      for (const sx of [-1, 1]) {
        brace.atPos(wx, wg + y, wz + sx * s, 0, 0, 0, s * 2, 1, 1);
        brace.atPos(wx + sx * s, wg + y, wz, Math.PI / 2, 0, 0, s * 2, 1, 1);
      }
    }
  }
  batch.add(M.galvanised(), new THREE.CylinderGeometry(4.4, 4.4, 8.4, detail ? 20 : 8), xform(wx, wg + legH + 4.2, wz));
  batch.add(M.galvanised(), lathe([4.4, wg + legH + 8.4, 3.4, wg + legH + 9.6, 0, wg + legH + 10.6], detail ? 16 : 8), xform(wx, 0, wz));
  ctx.collide.box(wx, wg + legH + 4.2, wz, 4.4, 4.2, 4.4, 0, { walkable: false });

  /* ---- the warden's house, burnt out in 1970 ---- */
  const hx = -cellW / 2 - 34;
  const hz = -10;
  const hg = ctx.ground(hx, hz);
  const ruin = M.paintedMasonry(0x8f8779);
  batch.add(ruin, box(26, 11, 17), xform(hx, hg + 5.5, hz));
  if (detail) {
    // Roofless: the walls stand, the openings are empty, the floors are gone.
    const empty = batch.instances(M.civicStone(0x1e1c1a), box(1.9, 3.0, 0.5));
    for (let f = 0; f < 2; f++) {
      for (let i = -3; i <= 3; i++) {
        empty.atPos(hx + i * 3.4, hg + 2.6 + f * 4.4, hz + 8.6);
        empty.atPos(hx + i * 3.4, hg + 2.6 + f * 4.4, hz - 8.6);
      }
    }
    // Broken gable ends and a chimney stack still standing.
    for (const s of [-1, 1]) {
      batch.add(ruin, box(1.1, 4.4, 17), xform(hx + s * 12.5, hg + 13, hz));
    }
    batch.add(M.brick(0xa07058), box(2.2, 7, 2.2), xform(hx + 9, hg + 14.5, hz + 4));
    // Rubble and scorched ground.
    const rubble = batch.instances(rock, box(1, 1, 1));
    const rr = rng.fork("rubble");
    for (let i = 0; i < 26; i++) {
      const px = hx + rr.range(-17, 17);
      const pz = hz + rr.range(-13, 13);
      const s = rr.range(0.5, 1.7);
      rubble.atPos(px, ctx.ground(px, pz) + s * 0.3, pz, rr.range(0, 3.14), rr.range(0, 0.5), 0, s, s * 0.6, s);
    }
  }
  ctx.collide.box(hx, hg + 5.5, hz, 13, 5.5, 8.5, 0, { walkable: false });

  /* ---- guard tower over the dock ---- */
  const dockDir = ringLocal(ctx, 6, 8)[detail ? 5 : 5];
  const gx = dockDir.x * 0.72;
  const gz = dockDir.z * 0.72;
  const gg = ctx.ground(gx, gz);
  const towerLegs = batch.instances(steel, box(0.34, 1, 0.34));
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) towerLegs.atPos(gx + sx * 1.8, gg + 8, gz + sz * 1.8, 0, 0, 0, 1, 16, 1);
  }
  batch.add(white, box(5.4, 3.0, 5.4), xform(gx, gg + 17.5, gz));
  batch.add(M.curtainGlass(0x46545c), box(5.6, 1.6, 5.6), xform(gx, gg + 17.8, gz));
  batch.add(roofMat, hipRoof(6.4, 6.4, 1.4, 0.4), xform(gx, gg + 19, gz));
  ctx.collide.box(gx, gg + 17.5, gz, 2.7, 1.5, 2.7, 0, { walkable: false });

  /* ---- the dock ---- */
  const dx = dockDir.x;
  const dz = dockDir.z;
  const dAng = Math.atan2(-dz, dx);
  const wharfY = 3.2;
  batch.add(M.deckTimber(0x9c8f78), box(44, 0.7, 16), xform(dx * 1.02, wharfY, dz * 1.02, dAng));
  ctx.collide.box(dx * 1.02, wharfY, dz * 1.02, 22, 0.5, 8, dAng, { walkable: true });
  const pile = batch.instances(M.deckTimber(0x6f6355), box(0.55, 1, 0.55));
  for (let i = -5; i <= 5; i++) {
    for (const s of [-1, 1]) {
      const px = dx * 1.02 + Math.cos(dAng) * i * 4 - Math.sin(dAng) * s * 6.5;
      const pz = dz * 1.02 - Math.sin(dAng) * i * 4 - Math.cos(dAng) * s * 6.5;
      pile.atPos(px, wharfY - 5.5, pz, 0, 0, 0, 1, 11, 1);
    }
  }
  batch.add(grimy, box(16, 8, 11), xform(dx * 1.02 + Math.cos(dAng) * 12, wharfY + 4.3, dz * 1.02 - Math.sin(dAng) * 12, dAng));
  batch.add(M.galvanised(), gableRoof(16, 11, 2.4, 0.5), xform(dx * 1.02 + Math.cos(dAng) * 12, wharfY + 8.3, dz * 1.02 - Math.sin(dAng) * 12, dAng));

  /* ---- the switchback road up from the dock ---- */
  if (detail) {
    const road: THREE.Vector3[] = [];
    for (let i = 0; i <= 16; i++) {
      const t = i / 16;
      const px = dx * (1 - t) * 0.95 + 0 * t;
      const pz = dz * (1 - t) * 0.95 + Math.sin(t * Math.PI * 1.5) * 26;
      road.push(new THREE.Vector3(px, ctx.ground(px, pz) + 0.25, pz));
    }
    const stripPos = new Float32Array(road.length * 2 * 3);
    const stripUv = new Float32Array(road.length * 2 * 2);
    const stripIdx: number[] = [];
    for (let i = 0; i < road.length; i++) {
      const a = road[Math.max(0, i - 1)];
      const b = road[Math.min(road.length - 1, i + 1)];
      const dxx = b.x - a.x;
      const dzz = b.z - a.z;
      const l = Math.hypot(dxx, dzz) || 1;
      const nx = -dzz / l;
      const nz = dxx / l;
      const p = road[i];
      stripPos[i * 6] = p.x + nx * 3;
      stripPos[i * 6 + 1] = p.y;
      stripPos[i * 6 + 2] = p.z + nz * 3;
      stripPos[i * 6 + 3] = p.x - nx * 3;
      stripPos[i * 6 + 4] = p.y;
      stripPos[i * 6 + 5] = p.z - nz * 3;
      stripUv[i * 4 + 1] = i;
      stripUv[i * 4 + 2] = 1;
      stripUv[i * 4 + 3] = i;
      if (i < road.length - 1) {
        stripIdx.push(i * 2, i * 2 + 1, i * 2 + 3, i * 2, i * 2 + 3, i * 2 + 2);
      }
    }
    const rg = new THREE.BufferGeometry();
    rg.setAttribute("position", new THREE.BufferAttribute(stripPos, 3));
    rg.setAttribute("uv", new THREE.BufferAttribute(stripUv, 2));
    rg.setIndex(stripIdx);
    rg.computeVertexNormals();
    batch.add(M.asphalt(), rg);
    ctx.collide.ribbon(road, 3, 0.4, { drivable: true, walkable: true });
  }

  /* ---- scrub and the gardens the inmates kept ---- */
  if (detail) {
    const shrub = batch.instances(M.foliage(0x6f7f4c), box(1, 0.1, 1));
    const sr = rng.fork("scrub");
    for (let i = 0; i < 70; i++) {
      const a = sr.range(0, Math.PI * 2);
      const r = sr.range(30, 150);
      const px = Math.cos(a) * r;
      const pz = Math.sin(a) * r;
      if (Math.abs(px) < cellW / 2 + 6 && Math.abs(pz) < cellD / 2 + 6) continue;
      const gy = ctx.ground(px, pz);
      if (gy < 4) continue;
      const s = sr.range(1.2, 3.4);
      for (let k = 0; k < 2; k++) {
        shrub.atPos(px, gy + s * 0.4, pz, (k / 2) * Math.PI + sr.range(0, 0.6), 0, 0, s, 1, s);
      }
    }
  }
}

export const alcatraz: LandmarkModule = {
  yaw: (_def: LandmarkDef) => AXIS,
  build,
  nearRange: (def) => Math.max(1200, def.radius * 6),
};
