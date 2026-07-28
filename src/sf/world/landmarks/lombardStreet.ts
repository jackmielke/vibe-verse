/**
 * The crooked block of Lombard Street, between Hyde and Leavenworth.
 *
 * The natural grade here is 27%, which is undrivable, so in 1922 the city laid
 * a one-way brick switchback down it: eight hairpin turns, 16% effective grade,
 * hydrangea beds in the wedges between the turns and a public stair down each
 * side of the right of way.
 *
 * It has to be *drivable*, which drives every decision below:
 *  - The centreline is a smoothed triangle wave, not a sine. A sine has no
 *    straight traverses and a car takes it as one long slalom; a triangle wave
 *    with its peaks rounded gives you real diagonal runs joined by real 180°
 *    turns, which is what makes driving it feel like the actual street.
 *  - The road surface is a ribbon collider registered as drivable, so the
 *    vehicle suspension finds it instead of the 27% hillside underneath.
 *  - The grade is constant end to end, taken from `terrainHeight` at the top
 *    and bottom of the block, so the road meets the cross streets flush.
 */
import * as THREE from "three";
import * as M from "./materials";
import { box, ribbon, stairs, xform } from "./kit";
import { streetYaw, type LandmarkCtx, type LandmarkModule } from "./types";
import { terrainHeight, type LandmarkDef } from "../../geo/sfGeo";

const BLOCK = 190; // Hyde to Leavenworth
const AMP = 10.6; // lateral swing of the centreline
const TURNS = 8;
const ROAD_HALF = 2.7; // one lane, one way, downhill
const ROW_HALF = 16; // the right of way, kerb to kerb of the walls

/** Smoothed triangle wave in [-1, 1] with `TURNS` reversals over t in [0,1]. */
function serpentine(samples: number): Float32Array {
  const raw = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const t = i / (samples - 1);
    const th = TURNS * Math.PI * t;
    raw[i] = (2 / Math.PI) * Math.asin(Math.sin(th));
  }
  // Three passes of a small box blur round the hairpins into real turning
  // radii without touching the straight traverses. Cheaper and more controllable
  // than fitting arcs, and the result is what a surveyor would have staked out.
  const out = new Float32Array(samples);
  let src = raw;
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < samples; i++) {
      const a = src[Math.max(0, i - 2)];
      const b = src[Math.max(0, i - 1)];
      const c = src[i];
      const d = src[Math.min(samples - 1, i + 1)];
      const e = src[Math.min(samples - 1, i + 2)];
      out[i] = (a + 2 * b + 3 * c + 2 * d + e) / 9;
    }
    src = out.slice();
  }
  return src;
}

function build(ctx: LandmarkCtx): void {
  const { batch, detail, rng } = ctx;
  const brickMat = M.brick(0xc98a68);
  const wallMat = M.paintedMasonry(0xd8d2c4);
  const hedgeMat = M.foliage(0x4e6b3c);

  const samples = detail ? 190 : 40;
  const wave = serpentine(samples);
  const topY = ctx.ground(-BLOCK / 2, 0);
  const botY = ctx.ground(BLOCK / 2, 0);

  const centre: THREE.Vector3[] = [];
  for (let i = 0; i < samples; i++) {
    const t = i / (samples - 1);
    const x = -BLOCK / 2 + BLOCK * t;
    // Constant grade: the whole point of the switchbacks.
    const y = topY + (botY - topY) * t + 0.18;
    centre.push(new THREE.Vector3(x, y, wave[i] * AMP));
  }

  /* ---------------- the roadway ---------------- */
  batch.add(brickMat, ribbon(centre, ROAD_HALF, 0.35));
  ctx.collide.ribbon(centre, ROAD_HALF + 0.2, 0.6, { drivable: true, walkable: true });

  // Kerbs: a raised granite edge either side, which is what actually stops you
  // cutting the corners, and reads as the white line in every photograph.
  for (const s of [-1, 1]) {
    const kerb = centre.map((p, i) => {
      const a = centre[Math.max(0, i - 1)];
      const b = centre[Math.min(samples - 1, i + 1)];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const l = Math.hypot(dx, dz) || 1;
      return new THREE.Vector3(
        p.x + (-dz / l) * s * (ROAD_HALF + 0.18),
        p.y + 0.14,
        p.z + (dx / l) * s * (ROAD_HALF + 0.18),
      );
    });
    batch.add(M.paving(0xcac3b4), ribbon(kerb, 0.22, 0.5));
  }

  /* ---------------- planting beds ---------------- */
  // The wedges between successive passes of the road. Each one is a raised bed
  // retained by a low wall, planted with a hedge spine and hydrangeas.
  if (detail) {
    const hedge = batch.instances(hedgeMat, box(1, 1, 1));
    const bloomPink = batch.instances(M.foliage(0xd58fb0), box(1, 1, 1));
    const bloomBlue = batch.instances(M.foliage(0x8fa8d8), box(1, 1, 1));
    const wallInst = batch.instances(wallMat, box(1, 0.55, 0.35));
    const r = rng.fork("planting");
    for (let i = 2; i < samples - 2; i += 2) {
      const p = centre[i];
      const a = centre[i - 1];
      const b = centre[i + 1];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const l = Math.hypot(dx, dz) || 1;
      const nx = -dz / l;
      const nz = dx / l;
      for (const s of [-1, 1]) {
        const off = ROAD_HALF + 1.5;
        const px = p.x + nx * s * off;
        const pz = p.z + nz * s * off;
        // Only plant where the bed is actually inside the right of way and
        // not on top of the next switchback down.
        if (Math.abs(pz) > ROW_HALF - 1) continue;
        const gy = p.y;
        wallInst.atPos(px, gy + 0.28, pz, Math.atan2(-dz, dx), 0, 0, 2.2, 1, 1);
        const hh = r.range(1.0, 1.7);
        hedge.atPos(px + nx * s * 0.9, gy + hh / 2, pz + nz * s * 0.9, r.range(0, 3.1), 0, 0, r.range(1.6, 2.4), hh, r.range(1.4, 2.0));
        if (r.chance(0.55)) {
          const bloom = r.chance(0.5) ? bloomPink : bloomBlue;
          const bs = r.range(0.55, 0.95);
          bloom.atPos(
            px + nx * s * r.range(0.4, 1.6),
            gy + hh * 0.85,
            pz + nz * s * r.range(0.4, 1.6),
            r.range(0, 3.1),
            0,
            0,
            bs,
            bs * 0.8,
            bs,
          );
        }
      }
    }

    // A few cypress and palm accents on the upper terraces, as on the real block.
    const trunk = batch.instances(M.deckTimber(0x82755f), box(1, 1, 1));
    const canopy = batch.instances(M.foliage(0x5d7444), box(1, 0.1, 1));
    for (let i = 0; i < 10; i++) {
      const t = r.range(0.05, 0.95);
      const x = -BLOCK / 2 + BLOCK * t;
      const z = (r.chance(0.5) ? 1 : -1) * r.range(AMP + 2.5, ROW_HALF - 0.5);
      const gy = topY + (botY - topY) * t;
      const h = r.range(6, 11);
      trunk.atPos(x, gy + h / 2, z, 0, 0, 0, 0.42, h, 0.42);
      for (let k = 0; k < 3; k++) {
        canopy.atPos(x, gy + h * 0.78 + k * 1.0, z, (k / 3) * Math.PI, 0, 0, 4.4 - k * 0.6, 1, 4.4 - k * 0.6);
      }
    }
  }

  /* ---------------- the public stairs ---------------- */
  // A flight down each side of the right of way, in ten landings.
  const flights = detail ? 10 : 3;
  const stairRail = batch.instances(M.darkSteel(), box(0.06, 1.0, 0.06));
  for (const s of [-1, 1]) {
    for (let i = 0; i < flights; i++) {
      const t0 = i / flights;
      const t1 = (i + 1) / flights;
      const x0 = -BLOCK / 2 + BLOCK * t0;
      const y0 = topY + (botY - topY) * t0;
      const y1 = topY + (botY - topY) * t1;
      const run = (BLOCK / flights) * 0.72;
      const steps = Math.max(2, Math.round(Math.max(0.1, y0 - y1) / 0.17));
      batch.add(
        M.paving(0xbdb6a8),
        stairs(steps, (y0 - y1) / steps, run / steps, 2.6),
        xform(x0 + run, y1, s * (ROW_HALF - 1.5), Math.PI),
      );
      // Landing between flights.
      batch.add(M.paving(0xb4ada0), box(BLOCK / flights - run + 0.6, 0.3, 2.6), xform(x0 + run + (BLOCK / flights - run) / 2, y1 - 0.15, s * (ROW_HALF - 1.5)));
      ctx.collide.box(x0 + BLOCK / flights / 2, (y0 + y1) / 2, s * (ROW_HALF - 1.5), BLOCK / flights / 2, (y0 - y1) / 2 + 0.3, 1.3, 0, { walkable: true });
      if (detail) {
        for (let k = 0; k < 6; k++) {
          stairRail.atPos(x0 + (BLOCK / flights) * (k / 6), y1 + 0.8, s * (ROW_HALF - 2.8));
        }
      }
    }
  }

  /* ---------------- retaining walls at the edges of the block ---------------- */
  for (const s of [-1, 1]) {
    const wall: THREE.Vector3[] = [];
    for (let i = 0; i < samples; i += 4) {
      const t = i / (samples - 1);
      const x = -BLOCK / 2 + BLOCK * t;
      wall.push(new THREE.Vector3(x, topY + (botY - topY) * t + 0.9, s * ROW_HALF));
    }
    batch.add(wallMat, ribbon(wall, 0.35, 1.9));
  }
}

/**
 * Pick the grid axis that actually runs downhill.
 *
 * The switchbacks only make sense in the descending direction, and which of the
 * two grid axes that is depends on where the terrain solver put Russian Hill's
 * crest — not on a compass bearing. So the module asks the terrain, and flips
 * the yaw by 180 degrees if it guessed the uphill way round.
 */
function downhillYaw(def: LandmarkDef): number {
  const a = streetYaw(def.x, def.z, 0);
  const ax = Math.cos(a);
  const az = -Math.sin(a);
  const hi = terrainHeight(def.x - ax * (BLOCK / 2), def.z - az * (BLOCK / 2));
  const lo = terrainHeight(def.x + ax * (BLOCK / 2), def.z + az * (BLOCK / 2));
  return lo <= hi ? a : a + Math.PI;
}

export const lombardStreet: LandmarkModule = {
  yaw: downhillYaw,
  build,
  nearRange: (def) => Math.max(420, def.radius * 5),
};
