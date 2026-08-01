/**
 * Vibe Kart — grandstands and the crowd.
 *
 * A circuit without a crowd is a test track. This builder is the single biggest
 * contributor to "this is a race, and people came to watch it", and it is built
 * around one structural idea: **a grandstand is a row of identical bays**.
 *
 * That is how real stadium engineering works and it is also how you draw seven
 * grandstands in two draw calls per sector. A bay is 9.6 m of stepped terracing
 * with a bench on every row; a stand is six to eighteen bays laid along the
 * centreline; the cantilevered roof is a second instanced module placed on the
 * same transform. Concrete tone varies by `instanceColor` on the terracing, and
 * the roof's team colour by `instanceColor` on the canopy — so seven visibly
 * different stands cost exactly the two geometries.
 *
 * The spectators are one `InstancedMesh` of a 62-triangle figure. Nothing about
 * them is updated on the CPU: shirt colour, complexion, bob rate, jump phase
 * and their place in the Mexican wave are all hashed from the instance origin
 * in the vertex shader (see `wind.ts`). Four thousand people, one draw call per
 * sector, zero per-frame cost beyond the vertex work.
 */
import * as THREE from "three";
import type { BuildCtx, SceneryPiece } from "./build";
import { MAX_BUILDABLE_BANK, type SampleFrame } from "./layout";
import {
  at,
  clamp,
  gBox,
  gCone,
  gCyl,
  gIco,
  merge,
  rand,
  setConst,
  shade,
  type Part,
} from "./util";

/** One bay of terracing. Everything else is derived from these five numbers. */
const BAY_W = 9.6;
const TIERS = 9;
const RISE = 0.78;
const RUN = 1.5;
const SEATS_ACROSS = 7;
const DEPTH = TIERS * RUN;
const HEIGHT = TIERS * RISE;
/** Clear metres between the road edge and the front wall — run-off plus barrier. */
const STAND_GAP = 7.5;

export interface StandSpec {
  /** Lap position of the first bay. */
  t0: number;
  bays: number;
  /** +1 when the stand sits on the racer's right at t0. */
  side: 1 | -1;
  roofed: boolean;
  /** Team colour of the canopy and seat trim. */
  tint: number;
  /** World position of the stand's front-wall midpoint, for signage. */
  anchor: THREE.Vector3;
}

/**
 * Canopy colours: saturated, but only six of them across a whole circuit, and
 * all of them in the warm-primary/teal family. Purple was in this list and it
 * read as a magenta roof from every angle — the one hue that pulls harder than
 * the karts do.
 */
const TEAM = [0xe8402a, 0x1b57c4, 0xffc21f, 0x2c8c3f, 0xf05a28, 0x0f8bd6];

const WHITE = new THREE.Color(1, 1, 1);
const ORIGIN = new THREE.Vector3();

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * The terracing module. Solid stepped mass rather than a floating staircase,
 * because the underside of a stand is visible from the outside of every corner
 * and a hollow one reads as a paper model.
 */
function bayGeometry(): THREE.BufferGeometry {
  const parts: Part[] = [];
  const concrete = 0xc9c3b6;

  for (let i = 0; i < TIERS; i++) {
    const h = (i + 1) * RISE;
    parts.push({
      geo: at(gBox(BAY_W, h, RUN), 0, h * 0.5, i * RUN + RUN * 0.5),
      // Each step a shade lighter going up: the terracing gets a readable
      // gradient without a single extra triangle or a shadow map.
      color: shade(concrete, -0.04 + (i / TIERS) * 0.07),
    });
    // Bench: the coloured band that makes a stand read as seating from 200 m.
    parts.push({
      geo: at(gBox(BAY_W - 0.3, 0.11, 0.46), 0, h + 0.4, i * RUN + RUN * 0.24),
      color: 0xffffff,
    });
    parts.push({
      geo: at(gBox(BAY_W - 0.3, 0.4, 0.1), 0, h + 0.2, i * RUN + RUN * 0.02),
      color: 0xf2f2ef,
    });
  }

  // Front safety wall, with a debris fence rail on top.
  parts.push({ geo: at(gBox(BAY_W, 1.25, 0.3), 0, 0.62, -0.15), color: 0xf0ede6 });
  parts.push({ geo: at(gBox(BAY_W, 0.09, 0.36), 0, 1.28, -0.15), color: 0x33383f });
  for (let i = 0; i < 5; i++) {
    const x = -BAY_W * 0.4 + (i / 4) * BAY_W * 0.8;
    parts.push({ geo: at(gBox(0.07, 1.35, 0.07), x, 1.95, -0.15), color: 0x9aa2ac });
  }
  parts.push({ geo: at(gBox(BAY_W, 0.06, 0.06), 0, 2.6, -0.15), color: 0x9aa2ac });

  // Back wall, closing the silhouette off from behind.
  parts.push({ geo: at(gBox(BAY_W, HEIGHT + 1.4, 0.34), 0, (HEIGHT + 1.4) * 0.5, DEPTH + 0.17), color: 0xb3ada1 });

  // Stair strip up one edge — the vertical break that stops the terracing
  // reading as a single extruded ramp.
  for (let i = 0; i < TIERS; i++) {
    parts.push({
      geo: at(gBox(1.15, 0.07, RUN * 0.94), -BAY_W * 0.5 + 0.62, (i + 1) * RISE + 0.04, i * RUN + RUN * 0.5),
      color: 0xdfd9cb,
    });
  }

  return merge(parts);
}

/** Cantilevered canopy: two rear columns, a raking beam, a fascia. */
function roofGeometry(): THREE.BufferGeometry {
  const parts: Part[] = [];
  const top = HEIGHT + 4.6;
  for (const sx of [-1, 1]) {
    const x = sx * (BAY_W * 0.5 - 0.55);
    parts.push({ geo: at(gBox(0.5, top, 0.5), x, top * 0.5, DEPTH - 0.5), color: 0xe7e3da });
    // Raking beam out over the seating, plus its tie-back.
    parts.push({ geo: at(gBox(0.34, 0.5, DEPTH * 0.86), x, top - 0.3, DEPTH * 0.55), color: 0xdad5cb });
    parts.push({ geo: at(gBox(0.2, 0.2, 3.2), x, top - 1.35, DEPTH - 1.1, 0, 0.62), color: 0xcfc9bd });
  }
  // Canopy deck, tilted a little forward so it catches the sun.
  parts.push({ geo: at(gBox(BAY_W, 0.22, DEPTH * 0.94), 0, top + 0.1, DEPTH * 0.52, 0, 0.05), color: 0xffffff });
  // Underside, darker: a white slab lit from above and below at once is the
  // most common giveaway that a roof is a box.
  parts.push({ geo: at(gBox(BAY_W - 0.1, 0.06, DEPTH * 0.9), 0, top - 0.06, DEPTH * 0.52, 0, 0.05), color: 0x8b8579 });
  // Fascia: the coloured strip along the leading edge.
  parts.push({ geo: at(gBox(BAY_W, 0.62, 0.16), 0, top - 0.06, DEPTH * 0.05), color: 0xffffff });
  // Purlins, visible from below.
  for (let i = 0; i < 4; i++) {
    parts.push({
      geo: at(gBox(BAY_W - 0.4, 0.13, 0.13), 0, top - 0.22, DEPTH * (0.14 + i * 0.24)),
      color: 0xb6b0a4,
    });
  }
  return merge(parts);
}

/**
 * One spectator, ~1.05 m tall, origin at the feet.
 *
 * Two custom attributes carry the shader's contract:
 *   `aArm`  = (shoulder.xyz, isArm) — the pivot the wave rotates about.
 *   `aTint` = (shirt, skin) — which palette entry multiplies this vertex.
 * Trousers and hair leave both at zero and keep the colour baked here.
 */
function spectatorGeometry(): THREE.BufferGeometry {
  const parts: Part[] = [];
  const noArm = [0, 0, 0, 0];

  const legs = at(gCyl(0.16, 0.13, 0.4, 5, true), 0, 0.2, 0);
  setConst(legs, "aArm", noArm);
  setConst(legs, "aTint", [0, 0]);
  parts.push({ geo: legs, color: 0x2d3646 });

  // Shoulders wider than the waist. Getting this the wrong way round — which is
  // the way `CylinderGeometry(top, bottom)` invites — gives a stand full of
  // traffic cones, and no amount of shirt colour rescues it.
  const torso = at(gCyl(0.2, 0.145, 0.44, 6, true), 0, 0.62, 0);
  setConst(torso, "aArm", noArm);
  setConst(torso, "aTint", [1, 0]);
  parts.push({ geo: torso, color: 0xffffff });

  // A neck, so the head sits *on* the shoulders instead of hovering over them.
  const neck = at(gCyl(0.075, 0.1, 0.07, 5, true), 0, 0.87, 0);
  setConst(neck, "aArm", noArm);
  setConst(neck, "aTint", [0, 1]);
  parts.push({ geo: neck, color: 0xffffff });

  const head = at(gIco(0.135), 0, 0.98, 0);
  setConst(head, "aArm", noArm);
  setConst(head, "aTint", [0, 1]);
  parts.push({ geo: head, color: 0xffffff });

  // A dark crown. It costs ten triangles and it is what gives the figure a
  // head-shaped silhouette against a bright sky at two hundred metres.
  const hair = at(gCone(0.132, 0.12, 5), 0, 1.05, 0);
  setConst(hair, "aArm", noArm);
  setConst(hair, "aTint", [0, 0]);
  parts.push({ geo: hair, color: 0x2a2118 });

  for (const sx of [-1, 1]) {
    const shoulderX = sx * 0.205;
    const shoulderY = 0.81;
    const arm = at(gCyl(0.055, 0.042, 0.36, 4, true), shoulderX, shoulderY - 0.18, 0);
    setConst(arm, "aArm", [shoulderX, shoulderY, 0, 1]);
    setConst(arm, "aTint", [0, 1]);
    parts.push({ geo: arm, color: 0xffffff });
  }

  return merge(parts);
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

/**
 * Choose where the stands go.
 *
 * The main stand always straddles the start/finish line — that is where the
 * camera is on lap one and where every screenshot of a racing game is taken.
 * The rest go on the straightest remaining stretches, on the *outside* of the
 * circuit, spread so no two share a sector.
 */
function chooseSites(b: BuildCtx, totalBays: number): StandSpec[] {
  const { sampler } = b;
  const rng = b.rng("stands/sites");
  const dt = BAY_W / Math.max(1, sampler.length);
  const sites: StandSpec[] = [];
  const frame: SampleFrame = sampler.frameAt(0);

  const outwardSide = (t: number): 1 | -1 => {
    const f = sampler.frameAt(t, frame);
    // Outside of the loop = the side the centroid is not on.
    const dx = f.position.x - sampler.centre.x;
    const dz = f.position.z - sampler.centre.z;
    return f.right.x * dx + f.right.z * dz >= 0 ? 1 : -1;
  };

  const mainBays = Math.max(6, Math.round(totalBays * 0.3));
  sites.push({
    t0: 1 - mainBays * dt * 0.62,
    bays: mainBays,
    side: outwardSide(0),
    roofed: true,
    tint: 0xffffff,
    anchor: new THREE.Vector3(),
  });

  // Rank candidate windows by straightness, then take greedily with a spacing
  // rule so the stands are distributed round the lap rather than clumped on the
  // one long straight.
  const candidates: Array<{ t: number; score: number }> = [];
  const steps = 96;
  for (let i = 0; i < steps; i++) {
    const t = i / steps;
    // Penalise bank as well as curvature: a stand wants a flat, straight
    // stretch, and a banked one would lose half its bays to the check below.
    candidates.push({ t, score: sampler.straightness(t, 0.04) + sampler.bankAt(t) * 0.02 });
  }
  candidates.sort((a, c) => a.score - c.score);

  let remaining = totalBays - mainBays;
  const used: number[] = [sites[0].t0 + mainBays * dt * 0.5];
  const minGap = 0.09;
  for (const cand of candidates) {
    if (remaining <= 4) break;
    let clash = false;
    for (const u of used) {
      const d = Math.abs(((cand.t - u + 1.5) % 1) - 0.5);
      if (d < minGap) {
        clash = true;
        break;
      }
    }
    if (clash) continue;
    const bays = Math.min(remaining, 5 + Math.floor(rng() * 7));
    sites.push({
      t0: cand.t - bays * dt * 0.5,
      bays,
      // Always outside the loop. A stand on the inside of a circuit blocks the
      // view of the corner it is watching, and it is not how tracks are built.
      side: outwardSide(cand.t),
      // Every stand gets a roof except the smallest, which read as open
      // terraces — variety in the skyline, and cheaper.
      roofed: bays >= 7 || rng() < 0.45,
      tint: TEAM[(rng() * TEAM.length) | 0],
      anchor: new THREE.Vector3(),
    });
    used.push(cand.t);
    remaining -= bays;
  }
  return sites;
}

export function buildStands(b: BuildCtx): SceneryPiece {
  const { field, mats, sampler, density, res } = b;
  const rng = b.rng("stands");

  const bayGeo = res.geo(bayGeometry());
  const roofGeo = res.geo(roofGeometry());
  const crowdGeo = res.geo(spectatorGeometry());

  const view = density.viewScale;
  const kBay = field.define({
    name: "standBay",
    geometry: bayGeo,
    material: mats.painted,
    viewDistance: 900 * view,
    castShadow: density.shadows,
    receiveShadow: true,
    colored: true,
  });
  const kRoof = field.define({
    name: "standRoof",
    geometry: roofGeo,
    material: mats.painted,
    viewDistance: 1100 * view,
    castShadow: density.shadows,
    receiveShadow: true,
    colored: true,
  });
  const kCrowd = field.define({
    name: "crowd",
    geometry: crowdGeo,
    material: mats.crowd,
    // Spectators are 1 m tall and hashed into noise past a couple of hundred
    // metres; drawing them further is pure vertex cost for no picture.
    viewDistance: 320 * view,
    castShadow: false,
    receiveShadow: true,
  });

  const sites = chooseSites(b, density.bays);
  const dt = BAY_W / Math.max(1, sampler.length);

  // Seat inventory first, so occupancy can be solved to hit the density target
  // exactly rather than by guessing a probability.
  let seatTotal = 0;
  for (const s of sites) seatTotal += s.bays * TIERS * SEATS_ACROSS;
  const occupancy = clamp(density.crowd / Math.max(1, seatTotal), 0.2, 0.99);

  const frame: SampleFrame = sampler.frameAt(0);
  const m = new THREE.Matrix4();
  const local = new THREE.Matrix4();
  const basisX = new THREE.Vector3();
  const basisY = new THREE.Vector3(0, 1, 0);
  const basisZ = new THREE.Vector3();
  const pos = new THREE.Vector3();
  const world = new THREE.Vector3();
  const tint = new THREE.Color();
  const euler = new THREE.Euler();
  const quat = new THREE.Quaternion();
  const scale = new THREE.Vector3();

  for (const site of sites) {
    for (let k = 0; k < site.bays; k++) {
      const t = site.t0 + k * dt;
      sampler.frameAt(t, frame);
      // A grandstand cannot stand against a banked wall — see props.ts.
      if (Math.abs(frame.bank) > MAX_BUILDABLE_BANK) continue;
      const side = site.side;

      // Outward is the direction the stand's back faces; forward flips with the
      // side so the bay's +X always runs along the stand and the basis stays
      // right-handed (X × Y = Z).
      basisZ.copy(frame.right).multiplyScalar(side).setY(0).normalize();
      basisX.copy(frame.forward).multiplyScalar(side).setY(0).normalize();

      pos
        .copy(frame.position)
        .addScaledVector(frame.right, side * (frame.halfWidth + STAND_GAP));
      pos.y = sampler.groundAt(pos.x, pos.z);

      m.makeBasis(basisX, basisY, basisZ);
      m.setPosition(pos);

      if (k === Math.floor(site.bays / 2)) site.anchor.copy(pos);

      // Nothing else may grow inside a grandstand. The circle is centred on the
      // terracing rather than the front wall so the signage still fits in front.
      b.plan.keepOut.push({
        x: pos.x + basisZ.x * DEPTH * 0.5,
        z: pos.z + basisZ.z * DEPTH * 0.5,
        r: DEPTH * 0.62,
      });

      // Concrete drifts warm/cool per bay: a stand of one flat grey is the
      // thing that reads as untextured no matter how good the material is.
      const warm = rand(rng, -0.03, 0.03);
      tint.setRGB(1 + warm, 1 + warm * 0.35, 1 - warm * 0.6);
      field.add(kBay, sampler.sectorOf(t), m, tint);

      if (site.roofed) {
        tint.setHex(site.tint, THREE.SRGBColorSpace);
        // Lift the team colour toward white, but only part way. Fully
        // saturated the canopy fights the karts for attention; fully washed out
        // the skyline is a row of identical grey sheds.
        tint.lerp(WHITE, 0.3);
        field.add(kRoof, sampler.sectorOf(t), m, tint);
      }

      // --- the crowd in this bay ---------------------------------------
      const sector = sampler.sectorOf(t);
      for (let row = 0; row < TIERS; row++) {
        for (let seat = 0; seat < SEATS_ACROSS; seat++) {
          if (rng() > occupancy) continue;
          const lx = -BAY_W * 0.5 + ((seat + 0.5) * BAY_W) / SEATS_ACROSS + rand(rng, -0.16, 0.16);
          const ly = (row + 1) * RISE + 0.05;
          const lz = row * RUN + RUN * 0.6 + rand(rng, -0.12, 0.12);
          world
            .copy(pos)
            .addScaledVector(basisX, lx)
            .addScaledVector(basisY, ly)
            .addScaledVector(basisZ, lz);
          // Yaw within the bay frame, so everyone is roughly facing the track
          // but nobody is perfectly aligned with their neighbour.
          euler.set(0, rand(rng, -0.34, 0.34), 0, "YXZ");
          quat.setFromEuler(euler);
          const h = rand(rng, 0.88, 1.13);
          scale.set(rand(rng, 0.9, 1.06), h, rand(rng, 0.9, 1.06));
          local.compose(ORIGIN, quat, scale);
          m.makeBasis(basisX, basisY, basisZ);
          m.setPosition(world);
          m.multiply(local);
          field.add(kCrowd, sector, m);
        }
      }
    }
  }

  b.plan.stands = sites;
  return {};
}

export const STAND_GEOMETRY = { BAY_W, TIERS, RISE, RUN, DEPTH, HEIGHT, STAND_GAP };
