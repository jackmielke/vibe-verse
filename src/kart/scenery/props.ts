/**
 * Vibe Kart — trackside furniture.
 *
 * Barriers, tyre walls, advertising, flags, bunting, air dancers, marshal posts
 * and the inflatable arches. Individually these are throwaway props; together
 * they are most of what separates a circuit from a grey ribbon on a lawn, and
 * they are also where a naive implementation burns its entire draw-call budget.
 *
 * So every one of them is a merged geometry drawn as an `InstancedMesh` through
 * the sector field, and the ones that need to look different from each other
 * get it from `instanceColor` or from an atlas cell hashed off the instance
 * origin. The whole file adds about ten instanced kinds.
 *
 * Placement runs off the resampled centreline with a global clearance test, so
 * a barrier is never laid across a piece of road that happens to fold back
 * underneath the corner it was following.
 */
import * as THREE from "three";
import type { BuildCtx, SceneryPiece } from "./build";
import { MAX_BUILDABLE_BANK, type SampleFrame } from "./layout";
import {
  at,
  clamp,
  gBox,
  gCyl,
  gPlane,
  gTorus,
  merge,
  rand,
  shade,
  strut,
  type Part,
  type Rng,
} from "./util";


/** Barrier segment length. Everything else steps in multiples of it. */
const SEG = 3.0;
/** Metres beyond the road edge the barrier line sits. */
const BARRIER_OFF = 3.1;

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** Armco: two W-profile rails on posts, authored along local X. */
function barrierGeometry(): THREE.BufferGeometry {
  const parts: Part[] = [];
  const steel = 0xd9dde2;
  for (const y of [0.52, 0.92]) {
    parts.push({ geo: at(gBox(SEG, 0.26, 0.09), 0, y, 0), color: steel });
    // The fold that makes an Armco rail catch the light in two bands.
    parts.push({ geo: at(gBox(SEG, 0.07, 0.14), 0, y, -0.03), color: shade(steel, 0.06) });
  }
  for (const sx of [-1, 1]) {
    parts.push({ geo: at(gBox(0.14, 1.25, 0.16), sx * (SEG * 0.5 - 0.12), 0.62, 0.06), color: 0x7b838d });
  }
  // A painted kerb sleeper at the foot, so the barrier meets ground rather than
  // hovering over whatever the terrain does.
  parts.push({ geo: at(gBox(SEG, 0.18, 0.42), 0, 0.09, 0.04), color: 0xb9b3a6 });
  return merge(parts);
}

/** A stack of four tyres with a coloured cap. Apex protection and colour. */
function tyreStackGeometry(): THREE.BufferGeometry {
  const parts: Part[] = [];
  for (let i = 0; i < 4; i++) {
    const y = 0.2 + i * 0.34;
    parts.push({
      geo: at(gTorus(0.44, 0.17, 5, 9), 0, y, 0, 0, Math.PI / 2),
      color: i === 3 ? 0xffffff : shade(0x22242a, i * 0.012),
    });
  }
  // The retaining strap every tyre wall has, and the bolt plate on top.
  parts.push({ geo: at(gBox(0.1, 1.25, 0.06), 0.4, 0.72, 0), color: 0xf0f0f0 });
  parts.push({ geo: at(gCyl(0.2, 0.2, 0.06, 8), 0, 1.42, 0), color: 0xe8e8e8 });
  return merge(parts);
}

/** Advertising hoarding: a board on two feet, art supplied by the atlas. */
function hoardingGeometry(): THREE.BufferGeometry {
  // The board is a plain quad — the sponsor material remaps its UV into one
  // atlas cell per instance, so the geometry must span exactly 0..1 in uv.
  const g = gPlane(4.8, 1.25, 1, 1);
  g.translate(0, 0.8, 0);
  return g;
}

function hoardingFrameGeometry(): THREE.BufferGeometry {
  const parts: Part[] = [
    { geo: at(gBox(4.9, 0.1, 0.12), 0, 1.45, 0.05), color: 0x3a4049 },
    { geo: at(gBox(4.9, 0.1, 0.12), 0, 0.16, 0.05), color: 0x3a4049 },
  ];
  for (const sx of [-1, 1]) {
    parts.push({ geo: at(gBox(0.1, 1.4, 0.1), sx * 2.3, 0.8, 0.06), color: 0x4a515b });
    // Rear legs, so a board seen from behind is a structure rather than a
    // culled plane hanging in the air.
    parts.push({ geo: at(gBox(0.08, 1.5, 0.08), sx * 2.3, 0.75, -0.4, 0, 0.22), color: 0x5a616b });
  }
  return merge(parts);
}

function poleGeometry(height: number): THREE.BufferGeometry {
  const parts: Part[] = [
    { geo: at(gCyl(0.055, 0.085, height, 6, true), 0, height * 0.5, 0), color: 0xe4e7ea },
    { geo: at(gCyl(0.24, 0.3, 0.28, 8), 0, 0.14, 0), color: 0xb9bec5 },
    { geo: at(gCyl(0.09, 0.09, 0.12, 6), 0, height + 0.05, 0), color: 0xffcc22 },
  ];
  return merge(parts);
}

/**
 * A flag, authored in the unit square with the hoist edge at x = 0. That
 * contract is the flag shader's: it pins x = 0 and lets the fly ripple, so the
 * instance matrix is free to scale it to any size.
 */
function flagGeometry(segments = 10): THREE.BufferGeometry {
  const g = gPlane(1, 1, segments, 5);
  g.translate(0.5, 0, 0);
  return g;
}

/** A bunting pennant: same contract, pinned along what will become its top. */
function pennantGeometry(): THREE.BufferGeometry {
  const g = gPlane(1, 1, 4, 3);
  g.translate(0.5, 0, 0);
  // Taper it to a point so it reads as a triangle rather than a small flag.
  const pos = g.getAttribute("position") as THREE.BufferAttribute;
  const arr = pos.array as Float32Array;
  for (let i = 0; i < pos.count; i++) {
    arr[i * 3 + 1] *= 1 - arr[i * 3];
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

/** Inflatable tube man: a tapered tube spanning y ∈ [0,1], plus its blower. */
function dancerGeometry(): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(0.09, 0.16, 1, 7, 14, true);
  g.translate(0, 0.5, 0);
  return g;
}

function dancerBaseGeometry(): THREE.BufferGeometry {
  const parts: Part[] = [
    { geo: at(gBox(0.8, 0.42, 0.62), 0, 0.21, 0), color: 0x33383f },
    { geo: at(gCyl(0.3, 0.3, 0.2, 8), 0, 0.5, 0), color: 0xffcc22 },
    { geo: at(gBox(0.9, 0.06, 0.72), 0, 0.02, 0), color: 0x5a6169 },
  ];
  return merge(parts);
}

/** Marshal post: hut, warning panel, extinguisher, a hi-vis figure. */
function marshalPostGeometry(): THREE.BufferGeometry {
  const parts: Part[] = [
    // Hut: three walls and a pitched roof, open toward the track.
    { geo: at(gBox(2.4, 0.12, 2.0), 0, 0.06, 0), color: 0x8f8a80 },
    { geo: at(gBox(2.4, 2.1, 0.14), 0, 1.05, 1.0), color: 0xf2efe8 },
    { geo: at(gBox(0.14, 2.1, 2.0), -1.13, 1.05, 0), color: 0xeae7e0 },
    { geo: at(gBox(0.14, 2.1, 2.0), 1.13, 1.05, 0), color: 0xeae7e0 },
    { geo: at(gBox(2.8, 0.14, 2.4), 0, 2.16, 0.1, 0, 0.08), color: 0xe8402a },
    { geo: at(gBox(2.9, 0.2, 0.16), 0, 2.06, -1.05), color: 0xc9351f },
    // Warning board with the yellow-flag stripe.
    { geo: at(gBox(1.5, 0.62, 0.08), 0, 1.6, -0.98), color: 0xffcc22 },
    { geo: at(gBox(1.5, 0.14, 0.1), 0, 1.42, -0.99), color: 0x1b1d22 },
    // Extinguisher and a bucket of sand — the details nobody notices missing
    // but everybody registers when they are there.
    { geo: at(gCyl(0.11, 0.12, 0.55, 7), 0.86, 0.35, 0.6), color: 0xe8402a },
    { geo: at(gCyl(0.2, 0.15, 0.3, 8), -0.8, 0.22, 0.62), color: 0xe0c98a },
    // The marshal: hi-vis body, dark trousers, a head.
    { geo: at(gCyl(0.19, 0.16, 0.62, 6), -0.35, 1.0, -0.55), color: 0xd6ff3a },
    { geo: at(gCyl(0.17, 0.15, 0.7, 6), -0.35, 0.35, -0.55), color: 0x2d3646 },
    { geo: at(gCyl(0.13, 0.13, 0.24, 6), -0.35, 1.42, -0.55), color: 0xe8b98d },
    { geo: at(gCyl(0.15, 0.16, 0.1, 7), -0.35, 1.57, -0.55), color: 0xffffff },
  ];
  return merge(parts);
}

/**
 * The inflatable arch. Authored with a unit span — radius 1, tube 0.12 — so a
 * single geometry stretches across roads of any width.
 */
function archGeometry(): THREE.BufferGeometry {
  const parts: Part[] = [];
  const arch = new THREE.TorusGeometry(1, 0.12, 8, 22, Math.PI);
  parts.push({ geo: at(arch, 0, 0, 0), color: 0xffffff });
  // Straight legs down to the anchors, plus the ballast blocks.
  for (const sx of [-1, 1]) {
    parts.push({ geo: at(gCyl(0.12, 0.14, 0.16, 8), sx, -0.08, 0), color: 0xf4f4f4 });
    parts.push({ geo: at(gBox(0.5, 0.12, 0.5), sx, -0.19, 0), color: 0x33383f });
  }
  // The banner panel slung under the crown.
  parts.push({ geo: at(gBox(1.5, 0.42, 0.05), 0, 0.86, 0), color: 0x1b2a6b });
  return merge(parts);
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export function buildProps(b: BuildCtx): SceneryPiece {
  const { field, mats, sampler, density, res, plan } = b;
  const rng: Rng = b.rng("props");
  const view = density.viewScale;

  const kBarrier = field.define({
    name: "barrier",
    geometry: res.geo(barrierGeometry()),
    material: mats.painted,
    viewDistance: 260 * view,
    castShadow: false,
    receiveShadow: true,
    colored: true,
  });
  const kTyre = field.define({
    name: "tyreStack",
    geometry: res.geo(tyreStackGeometry()),
    material: mats.painted,
    viewDistance: 240 * view,
    castShadow: density.shadows,
    receiveShadow: true,
    colored: true,
  });
  const kHoarding = field.define({
    name: "hoarding",
    geometry: res.geo(hoardingGeometry()),
    material: mats.sponsor,
    viewDistance: 340 * view,
    castShadow: false,
    receiveShadow: true,
  });
  const kHoardFrame = field.define({
    name: "hoardingFrame",
    geometry: res.geo(hoardingFrameGeometry()),
    material: mats.painted,
    viewDistance: 300 * view,
    castShadow: false,
    receiveShadow: true,
  });
  const kPole = field.define({
    name: "flagPole",
    geometry: res.geo(poleGeometry(7)),
    material: mats.painted,
    viewDistance: 480 * view,
    castShadow: false,
    receiveShadow: true,
  });
  const kFlag = field.define({
    name: "flag",
    geometry: res.geo(flagGeometry(10)),
    material: mats.flag,
    viewDistance: 480 * view,
    castShadow: false,
    receiveShadow: false,
  });
  const kPennant = field.define({
    name: "pennant",
    geometry: res.geo(pennantGeometry()),
    material: mats.flag,
    viewDistance: 220 * view,
    castShadow: false,
    receiveShadow: false,
  });
  const kDancer = field.define({
    name: "airDancer",
    geometry: res.geo(dancerGeometry()),
    material: mats.dancer,
    viewDistance: 420 * view,
    castShadow: false,
    receiveShadow: false,
  });
  const kDancerBase = field.define({
    name: "airDancerBase",
    geometry: res.geo(dancerBaseGeometry()),
    material: mats.painted,
    viewDistance: 260 * view,
    receiveShadow: true,
  });
  const kMarshal = field.define({
    name: "marshalPost",
    geometry: res.geo(marshalPostGeometry()),
    material: mats.painted,
    viewDistance: 380 * view,
    castShadow: density.shadows,
    receiveShadow: true,
    colored: true,
  });
  const kArch = field.define({
    name: "inflatableArch",
    geometry: res.geo(archGeometry()),
    material: mats.fabric,
    viewDistance: 700 * view,
    castShadow: false,
    receiveShadow: false,
    colored: true,
  });

  const frame: SampleFrame = sampler.frameAt(0);
  const m = new THREE.Matrix4();
  const bx = new THREE.Vector3();
  const by = new THREE.Vector3(0, 1, 0);
  const bz = new THREE.Vector3();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  const tint = new THREE.Color();

  /**
   * Stand a prop at lateral `offset` from the centreline on `side`, facing the
   * road. Local +X runs along the track, +Z points away from it — the same
   * basis every trackside module in this directory uses.
   */
  interface PlaceOpts {
    lift?: number;
    scale?: number;
    scaleX?: number;
    scaleY?: number;
    colour?: THREE.Color;
    /** Turn the prop round so its own +Z looks back at the road. */
    faceTrack?: boolean;
  }

  const placeTrackside = (
    kind: number,
    t: number,
    side: 1 | -1,
    offset: number,
    o: PlaceOpts = {},
  ): boolean => {
    const scale = o.scale ?? 1;
    sampler.frameAt(t, frame);
    // Nothing stands beside a wall-ride. Offsetting horizontally from the
    // centreline of a banked section puts the prop inside the road surface,
    // which is how you get an Armco barrier climbing a vertical bank.
    if (Math.abs(frame.bank) > MAX_BUILDABLE_BANK) return false;
    pos
      .copy(frame.position)
      .addScaledVector(frame.right, side * (frame.halfWidth + offset));
    // Reject anything the circuit folds back underneath: a barrier laid across
    // the back straight because it was following the outside of turn three.
    if (sampler.clearance(pos.x, pos.z) < offset * 0.45) return false;
    pos.y = sampler.groundAt(pos.x, pos.z) + (o.lift ?? 0);
    // Negating both X and Z keeps the basis right-handed while spinning the
    // prop through 180° — which is all a signboard needs to face the racing.
    const f = o.faceTrack ? -side : side;
    bx.copy(frame.forward).multiplyScalar(f).setY(0).normalize();
    bz.copy(frame.right).multiplyScalar(f).setY(0).normalize();
    m.makeBasis(bx, by, bz);
    m.scale(scl.set(o.scaleX ?? scale, o.scaleY ?? scale, scale));
    m.setPosition(pos);
    field.add(kind, sampler.sectorOf(t), m, o.colour);
    return true;
  };

  const lap = Math.max(1, sampler.length);

  // --- barriers, both sides, the whole lap ---------------------------------
  const segs = Math.floor(lap / SEG);
  for (let i = 0; i < segs; i++) {
    const t = i / segs;
    for (const side of [1, -1] as const) {
      // Steel drifts warm and cool along a run; a barrier of one flat grey is
      // a mile of the same pixel and reads as a placeholder immediately.
      const w = rand(rng, -0.035, 0.035);
      tint.setRGB(1 + w, 1 + w * 0.4, 1 - w * 0.5);
      placeTrackside(kBarrier, t, side, BARRIER_OFF, { colour: tint });
    }
  }

  // --- tyre walls at the apexes -------------------------------------------
  // Where the road bends hardest is where a real circuit stacks tyres, and it
  // is also exactly where the player's eye is during a drift.
  const apexSteps = 320;
  for (let i = 0; i < apexSteps; i++) {
    const t = i / apexSteps;
    sampler.frameAt(t, frame);
    const k = Math.abs(frame.curvature);
    if (k < 0.008) continue;
    // Outside of the bend: curvature is signed, + turns right.
    const side: 1 | -1 = frame.curvature > 0 ? -1 : 1;
    const rows = k > 0.02 ? 3 : 2;
    for (let r = 0; r < rows; r++) {
      const bright = rng() < 0.22;
      tint.setHex(bright ? [0xffcc22, 0xe8402a, 0x2b6ad1][(rng() * 3) | 0] : 0xffffff, THREE.SRGBColorSpace);
      placeTrackside(kTyre, t, side, BARRIER_OFF + 0.55 + r * 0.95, {
        scale: rand(rng, 0.92, 1.08),
        colour: tint,
      });
    }
  }

  // --- advertising ---------------------------------------------------------
  // In front of the barrier line, facing the road. The sponsor material picks
  // one of sixteen designs per instance from the atlas.
  const ads = density.hoardings;
  for (let i = 0; i < ads; i++) {
    const t = (i / ads + 0.013) % 1;
    const side: 1 | -1 = i % 2 === 0 ? 1 : -1;
    // The board faces the track: the quad's own +Z must point inward, so the
    // basis is taken from the opposite side.
    if (placeTrackside(kHoarding, t, side, BARRIER_OFF - 0.35, { faceTrack: true })) {
      placeTrackside(kHoardFrame, t, side, BARRIER_OFF - 0.31, { faceTrack: true });
    }
  }

  // --- flags ---------------------------------------------------------------
  const flags = density.flags;
  for (let i = 0; i < flags; i++) {
    const t = (i / flags + 0.041) % 1;
    const side: 1 | -1 = i % 3 === 0 ? -1 : 1;
    const off = BARRIER_OFF + 2.6 + rand(rng, 0, 2.2);
    const h = rand(rng, 0.9, 1.15);
    if (!placeTrackside(kPole, t, side, off, { scale: h })) continue;
    // The flag hangs from the top of its pole: hoist edge on the mast, fly free
    // downwind, 1.9 m long by 1.15 m deep — a real racing flag.
    placeTrackside(kFlag, t, side, off, {
      lift: 7 * h - 1.35,
      scale: 1.15,
      scaleX: 1.9,
      scaleY: 1.15,
    });
  }

  // --- bunting -------------------------------------------------------------
  // Runs of pennants strung between short posts along the outside of the
  // stands, sagging on a catenary.
  const buntingRuns = Math.max(2, Math.round(density.flags / 6));
  const ropeParts: Part[] = [];
  const prev = new THREE.Vector3();
  const here = new THREE.Vector3();
  const rope = new THREE.Vector3();
  for (let r = 0; r < buntingRuns; r++) {
    const t0 = rng();
    const side: 1 | -1 = rng() < 0.5 ? 1 : -1;
    const posts = 4;
    const dt = 22 / lap / (posts - 1);
    let have = false;
    for (let p = 0; p < posts; p++) {
      const t = t0 + p * dt;
      sampler.frameAt(t, frame);
      const off = BARRIER_OFF + 1.9;
      const px = frame.position.x + frame.right.x * side * (frame.halfWidth + off);
      const pz = frame.position.z + frame.right.z * side * (frame.halfWidth + off);
      if (sampler.clearance(px, pz) < 1.5) {
        have = false;
        continue;
      }
      const top = sampler.groundAt(px, pz) + 3.5;
      here.set(px, top, pz);
      ropeParts.push({
        geo: strut(gCyl(0.5, 0.7, 1, 5, true), px, top - 3.5, pz, px, top, pz, 0.09),
        color: 0xd9dde2,
      });

      if (have) {
        const pennants = 8;
        const sagDepth = 1.25;
        // Walk the span, dropping a rope segment and a pennant per step. The
        // sag is a parabola rather than a cosh: over 7 m they are the same
        // curve to within a millimetre and one of them is a single multiply.
        let ax = prev.x;
        let ay = prev.y;
        let az = prev.z;
        for (let k = 1; k <= pennants; k++) {
          const f = k / pennants;
          const x = prev.x + (here.x - prev.x) * f;
          const z = prev.z + (here.z - prev.z) * f;
          const y = prev.y + (here.y - prev.y) * f - sagDepth * 4 * f * (1 - f);
          ropeParts.push({ geo: strut(gBox(1, 1, 1), ax, ay, az, x, y, z, 0.04), color: 0x2f3440 });
          if (k < pennants) {
            // The flag shader pins local x = 0. Rolling the basis a quarter
            // turn — X down, Y along the rope — hangs the pennant from the
            // line and lets the ripple run across it.
            rope.set(here.x - prev.x, 0, here.z - prev.z).normalize();
            bx.set(0, -1, 0);
            by.copy(rope);
            bz.crossVectors(bx, by);
            m.makeBasis(bx, by, bz);
            m.scale(scl.set(0.48, 0.32, 0.32));
            m.setPosition(pos.set(x, y - 0.02, z));
            field.add(kPennant, sampler.sectorAtPoint(x, z), m);
          }
          ax = x;
          ay = y;
          az = z;
        }
      }
      prev.copy(here);
      have = true;
    }
  }
  if (ropeParts.length > 0) {
    const ropeGeo = res.geo(merge(ropeParts));
    const rope = new THREE.Mesh(ropeGeo, mats.painted);
    rope.name = "scenery/bunting-rope";
    rope.castShadow = false;
    rope.receiveShadow = true;
    b.root.add(rope);
  }

  // --- air dancers ---------------------------------------------------------
  const dancers = Math.max(3, Math.round(density.flags / 5));
  for (let i = 0; i < dancers; i++) {
    const t = (i / dancers + 0.19) % 1;
    const side: 1 | -1 = i % 2 === 0 ? 1 : -1;
    const off = BARRIER_OFF + 1.6;
    const h = rand(rng, 4.6, 6.4);
    if (!placeTrackside(kDancer, t, side, off, { lift: 0.5, scale: 0.85, scaleY: h })) continue;
    placeTrackside(kDancerBase, t, side, off);
  }

  // --- marshal posts -------------------------------------------------------
  const marshalCount = clamp(Math.round(lap / 220), 4, 12);
  for (let i = 0; i < marshalCount; i++) {
    // Nudge each post to the nearest tight corner: marshals stand where the
    // accidents happen, and it puts them in frame during the interesting bits.
    let bestT = i / marshalCount;
    let bestK = -1;
    for (let s = 0; s < 14; s++) {
      const t = (i / marshalCount + (s / 14) * (1 / marshalCount)) % 1;
      const k = Math.abs(sampler.frameAt(t, frame).curvature);
      if (k > bestK) {
        bestK = k;
        bestT = t;
      }
    }
    sampler.frameAt(bestT, frame);
    const side: 1 | -1 = frame.curvature > 0 ? -1 : 1;
    const w = rand(rng, -0.03, 0.03);
    tint.setRGB(1 + w, 1 + w * 0.3, 1 - w * 0.4);
    placeTrackside(kMarshal, bestT, side, BARRIER_OFF + 5.2, { colour: tint, faceTrack: true });
  }

  // --- inflatable arches ---------------------------------------------------
  // Over the flattest, straightest stretches, which is where a track designer
  // puts a jump and where an arch reads best against the sky.
  const archCount = 3;
  const archSpots: number[] = [];
  const cands: Array<{ t: number; score: number }> = [];
  for (let i = 0; i < 64; i++) {
    const t = i / 64;
    cands.push({ t, score: sampler.straightness(t, 0.03) });
  }
  cands.sort((a, c) => a.score - c.score);
  for (const cand of cands) {
    if (archSpots.length >= archCount) break;
    if (archSpots.some((t) => Math.abs(((cand.t - t + 1.5) % 1) - 0.5) < 0.14)) continue;
    // Keep clear of the start/finish gantry, which owns that piece of sky.
    if (Math.abs(((cand.t - plan.startT + 1.5) % 1) - 0.5) < 0.1) continue;
    archSpots.push(cand.t);
  }
  const archHue = [0xff4a1f, 0x14b7e8, 0xffc400];
  for (let i = 0; i < archSpots.length; i++) {
    const t = archSpots[i];
    sampler.frameAt(t, frame);
    const span = frame.halfWidth + 3.6;
    pos.copy(frame.position);
    pos.y = sampler.groundAt(pos.x, pos.z) + 0.2;
    // The arch plane is perpendicular to the road: local X across, Y up, Z
    // along the direction of travel.
    bx.copy(frame.right).setY(0).normalize();
    bz.copy(frame.forward).setY(0).normalize();
    by.set(0, 1, 0);
    m.makeBasis(bx, by, bz);
    m.scale(scl.set(span, span * 0.86, span * 0.28));
    m.setPosition(pos);
    // Barely lifted toward white: an inflatable is a bright, flat, saturated
    // object, and washing it out is what made the first pass read as canvas.
    tint.setHex(archHue[i % archHue.length], THREE.SRGBColorSpace).lerp(WHITE, 0.08);
    field.add(kArch, sampler.sectorOf(t), m, tint);
    plan.keepOut.push({ x: pos.x, z: pos.z, r: span + 3 });
  }

  return {};
}

const WHITE = new THREE.Color(1, 1, 1);
