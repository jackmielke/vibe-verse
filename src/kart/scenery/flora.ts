/**
 * Vibe Kart — vegetation.
 *
 * Three tree species, a bush and a grass layer, all built the same way: a solid
 * procedural trunk plus a cluster of alpha-cut foliage cards, merged into one
 * geometry per part and instanced across the circuit.
 *
 * The two things that decide whether card foliage looks like a tree or like a
 * pile of playing cards:
 *
 *  1. **Spherical normals.** A card's real normal points out of its face, so a
 *     canopy lights as two flat sheets — one blown out, one black. Re-aiming the
 *     normals away from the canopy centre (`sphericalNormals` in `util.ts`)
 *     makes the same triangles shade as a volume of leaves. This is the single
 *     highest-value line in the file.
 *
 *  2. **Silhouette, not fill.** The cards are arranged so the outline of the
 *     canopy is broken from every angle: crossed pairs at the core, tilted
 *     outliers around the rim, no two cards coplanar. A tree modelled as three
 *     orthogonal quads is recognisable as three orthogonal quads at 40 km/h.
 *
 * Trunk and canopy share the same wind bend, normalised against the same local
 * height, so the canopy never shears off the trunk it is supposed to be growing
 * out of.
 */
import * as THREE from "three";
import type { BuildCtx, SceneryPiece } from "./build";
import { scatter } from "./layout";
import {
  TAU,
  at,
  gCone,
  gCyl,
  gIco,
  gPlane,
  merge,
  rand,
  sphericalNormals,
  type Part,
  type Rng,
} from "./util";

/**
 * A foliage card. The plane is authored face-up in XY and then yawed/pitched
 * into place; `anchorX` shifts the pivot to the card's left edge, which is what
 * a palm frond needs (it grows *out* of a point rather than straddling it).
 */
function card(
  w: number,
  h: number,
  x: number,
  y: number,
  z: number,
  yaw: number,
  pitch: number,
  roll = 0,
  anchorX = 0,
): THREE.BufferGeometry {
  const g = gPlane(w, h, 1, 1);
  if (anchorX !== 0) g.translate(anchorX * w * 0.5, 0, 0);
  return at(g, x, y, z, yaw, pitch, roll);
}

// ---------------------------------------------------------------------------
// Species
// ---------------------------------------------------------------------------

const BROADLEAF_H = 7.5;
const CONIFER_H = 11;
const PALM_H = 9;

interface Species {
  trunk: THREE.BufferGeometry;
  canopy: THREE.BufferGeometry;
}

function broadleaf(rng: Rng): Species {
  const trunkTop = 4.0;
  const parts: Part[] = [
    { geo: at(gCyl(0.17, 0.34, trunkTop, 6, true), 0, trunkTop * 0.5, 0), color: 0xa8875c },
    // A flare at the base: trees are wider where they meet the ground and the
    // eye notices its absence long before it notices its presence.
    { geo: at(gCyl(0.34, 0.52, 0.5, 6, true), 0, 0.25, 0), color: 0x8f7049 },
  ];
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * TAU + 0.4;
    const r = 0.9 + rng() * 0.5;
    const y0 = trunkTop * (0.62 + i * 0.09);
    parts.push({
      geo: at(gCyl(0.07, 0.13, 1.7, 4, true), Math.cos(a) * r * 0.5, y0 + 0.6, Math.sin(a) * r * 0.5, a, 0.55),
      color: 0x9d7d54,
    });
  }
  // An opaque core inside the canopy. Cards alone leave sky showing through
  // every gap and the tree reads as a handful of flat cut-outs; a solid mass
  // behind them turns the same cards into the *surface* of a volume. It rides
  // in the trunk mesh, so it costs twenty triangles and no extra draw call.
  parts.push({ geo: at(gIco(1.75, 1), 0, 5.5, 0, 0, 0, 0, 1, 0.82, 1), color: 0x2c5f2c });
  const trunk = merge(parts);

  const cy = 5.65;
  const cards: Part[] = [];
  // Crossed pair through the core, then a ring of tilted outliers.
  cards.push({ geo: card(4.4, 4.0, 0, cy, 0, 0.0, 0) });
  cards.push({ geo: card(4.2, 3.8, 0, cy - 0.15, 0, Math.PI / 2, 0) });
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * TAU + rng() * 0.5;
    const r = 1.15 + rng() * 0.55;
    cards.push({
      geo: card(
        3.0 + rng() * 1.1,
        2.5 + rng() * 0.9,
        Math.cos(a) * r,
        cy + rand(rng, -0.9, 1.1),
        Math.sin(a) * r,
        a + Math.PI / 2,
        rand(rng, -0.5, 0.35),
        rand(rng, -0.3, 0.3),
      ),
    });
  }
  const canopy = sphericalNormals(merge(cards), 0, cy, 0, 0.86);
  return { trunk, canopy };
}

function conifer(rng: Rng): Species {
  const h = CONIFER_H;
  const parts: Part[] = [
    { geo: at(gCyl(0.09, 0.36, h, 6, true), 0, h * 0.5, 0), color: 0x93704a },
    { geo: at(gCyl(0.36, 0.58, 0.6, 6, true), 0, 0.3, 0), color: 0x7d5f3e },
  ];
  // The opaque cone the boughs grow out of. Without it a tiered-card conifer is
  // unmistakably a stack of discs on a pole — the cards have to break a solid
  // silhouette, not be the silhouette. Two nested cones give the dark interior
  // a second value so it does not read as a single flat green triangle.
  parts.push({ geo: at(gCone(2.35, h - 2.3, 9), 0, 1.6 + (h - 2.3) * 0.5, 0), color: 0x25543a });
  parts.push({ geo: at(gCone(1.55, h - 4.4, 9), 0, 3.4 + (h - 4.4) * 0.5, 0), color: 0x2e6644 });
  const trunk = merge(parts);

  const cards: Part[] = [];
  // Eight tiers spaced closer than a card is tall, so the boughs *overlap*.
  // Spaced any wider and the tree reads as a pole with plates threaded onto it
  // — the failure mode of every tiered-card conifer ever built.
  const tiers = 8;
  for (let k = 0; k < tiers; k++) {
    const f = k / (tiers - 1);
    const y = 1.7 + f * (h - 2.4);
    // A hard, near-linear taper. The silhouette of a fir is a triangle, and if
    // the tiers do not shrink fast enough you get a green column instead.
    const w = 6.0 * (1 - f * 0.88);
    const hh = 2.8 * (1 - f * 0.6);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU + k * 0.51;
      cards.push({
        // Boughs droop, harder toward the base: the pitch is what separates a
        // fir from a stack of triangles, and it costs nothing.
        geo: card(w, hh, 0, y, 0, a, -0.3 - (1 - f) * 0.22, rand(rng, -0.07, 0.07)),
      });
    }
  }
  // A leader spike so the top is a point against the sky, not a card edge.
  cards.push({ geo: card(1.4, 2.4, 0, h - 0.4, 0, 0.5, 0) });
  cards.push({ geo: card(1.4, 2.4, 0, h - 0.4, 0, 0.5 + Math.PI / 2, 0) });
  // Normals aimed at a point *below* the canopy centre push the shading down
  // the cone, which is how a conifer actually catches light.
  const canopy = sphericalNormals(merge(cards), 0, h * 0.35, 0, 0.6);
  return { trunk, canopy };
}

function palm(rng: Rng): Species {
  // A leaning, segmented trunk. Straight palms look like poles.
  const segs = 8;
  const parts: Part[] = [];
  const lean = rand(rng, 0.1, 0.2);
  let px = 0;
  let py = 0;
  for (let i = 0; i < segs; i++) {
    const f = i / segs;
    const segH = PALM_H / segs;
    const r0 = 0.3 - f * 0.14;
    const dx = Math.sin(f * 1.5) * lean;
    parts.push({
      geo: at(gCyl(r0 * 0.92, r0, segH * 1.05, 6, true), px + dx * 0.5, py + segH * 0.5, 0, 0, 0, dx * 0.5),
      // Palms band light and dark up the trunk as the old frond bases scar.
      color: i % 2 === 0 ? 0xc0a87f : 0xa8926c,
    });
    px += dx;
    py += segH;
  }
  const trunk = merge(parts);

  const cards: Part[] = [];
  const crownX = px;
  const crownY = py + 0.1;
  const fronds = 9;
  for (let i = 0; i < fronds; i++) {
    const a = (i / fronds) * TAU + rand(rng, -0.15, 0.15);
    const droop = -0.28 - rng() * 0.5;
    // anchorX = 1 pins the frond's base at the crown so it radiates outward.
    cards.push({
      geo: card(4.6 + rng() * 0.9, 1.7, crownX, crownY, 0, a, droop, 0, 1),
    });
  }
  // Coconuts: three tiny spheres. Nobody will consciously see them and
  // everybody would feel their absence.
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * TAU;
    cards.push({
      geo: at(gIco(0.16), crownX + Math.cos(a) * 0.28, crownY - 0.28, Math.sin(a) * 0.28),
      color: 0xa88a48,
    });
  }
  const canopy = sphericalNormals(merge(cards), crownX, crownY + 0.6, 0, 0.75);
  return { trunk, canopy };
}

function bushGeometry(rng: Rng): THREE.BufferGeometry {
  const cards: Part[] = [];
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU + rng() * 0.4;
    cards.push({
      geo: card(1.9 + rng() * 0.6, 1.5 + rng() * 0.5, 0, 0.78 + rand(rng, -0.16, 0.2), 0, a, rand(rng, -0.25, 0.25)),
    });
  }
  return sphericalNormals(merge(cards), 0, 0.8, 0, 0.9);
}

/**
 * A clump of grass: three crossed quads rooted at y = 0 so the wind bend pivots
 * at the soil.
 *
 * Deliberately a *clump*, not a blade. A tuft small enough to be one plant
 * needs forty thousand instances to cover a verge, which is a third of the
 * triangle budget for something six pixels tall; a 1.3 m patch does the same
 * job — breaking the hard line where tarmac meets turf — at a tenth of it.
 */
function tuftGeometry(): THREE.BufferGeometry {
  const cards: Part[] = [];
  for (let i = 0; i < 3; i++) {
    const g = gPlane(1.3, 0.72, 1, 1);
    g.translate(0, 0.36, 0);
    cards.push({ geo: at(g, 0, 0, 0, (i / 3) * Math.PI, 0, 0), color: 0xffffff });
  }
  return merge(cards);
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export function buildFlora(b: BuildCtx): SceneryPiece {
  const { field, mats, sampler, density, res, plan } = b;
  const rng = b.rng("flora");
  const view = density.viewScale;

  const species = [
    { name: "broadleaf", geo: broadleaf(b.rng("flora/broadleaf")), leaf: mats.leafBroadleaf, depth: mats.depth?.broadleaf, weight: 0.45, scale: [0.72, 1.3] },
    { name: "conifer", geo: conifer(b.rng("flora/conifer")), leaf: mats.leafConifer, depth: mats.depth?.conifer, weight: 0.34, scale: [0.66, 1.22] },
    { name: "palm", geo: palm(b.rng("flora/palm")), leaf: mats.leafPalm, depth: mats.depth?.palm, weight: 0.21, scale: [0.8, 1.25] },
  ] as const;

  const kinds = species.map((s) => {
    res.geo(s.geo.trunk);
    res.geo(s.geo.canopy);
    return {
      trunk: field.define({
        name: `${s.name}Trunk`,
        geometry: s.geo.trunk,
        material: mats.bark,
        viewDistance: 460 * view,
        castShadow: density.shadows,
        receiveShadow: true,
        colored: true,
      }),
      canopy: field.define({
        name: `${s.name}Canopy`,
        geometry: s.geo.canopy,
        material: s.leaf,
        viewDistance: 520 * view,
        castShadow: density.shadows,
        receiveShadow: true,
        colored: true,
        customDepthMaterial: density.shadows ? s.depth : undefined,
      }),
    };
  });

  const bushGeo = res.geo(bushGeometry(b.rng("flora/bush")));
  const kBush = field.define({
    name: "bush",
    geometry: bushGeo,
    material: mats.leafBush,
    viewDistance: 190 * view,
    castShadow: false,
    receiveShadow: true,
    colored: true,
    customDepthMaterial: density.shadows ? mats.depth?.bush : undefined,
  });

  const tuftGeo = res.geo(tuftGeometry());
  const kTuft = field.define({
    name: "grassTuft",
    geometry: tuftGeo,
    material: mats.grass,
    // Tufts are 60 cm tall. Past a hundred metres they are sub-pixel noise that
    // costs a hundred thousand vertices, so they simply stop.
    viewDistance: 110 * view,
    castShadow: false,
    receiveShadow: true,
    colored: true,
  });

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  const tint = new THREE.Color();

  const place = (
    kind: number,
    sector: number,
    x: number,
    y: number,
    z: number,
    yaw: number,
    sx: number,
    sy: number,
    colour: THREE.Color | undefined,
  ) => {
    e.set(0, yaw, 0, "YXZ");
    q.setFromEuler(e);
    p.set(x, y, z);
    s.set(sx, sy, sx);
    m.compose(p, q, s);
    field.add(kind, sector, m, colour);
  };

  // --- trees ---------------------------------------------------------------
  // Cumulative weights, so species mix is a table edit rather than a rewrite.
  const cw: number[] = [];
  let acc = 0;
  for (const sp of species) cw.push((acc += sp.weight));

  scatter(
    sampler,
    b.rng("flora/trees"),
    {
      count: density.trees,
      // Twelve metres of clear ground before the treeline. Closer than that and
      // the wood stands on top of the barrier, blocking the view through every
      // corner — the racing line has to stay readable through the scenery.
      minOffset: 12,
      maxOffset: 110,
      // A moderate falloff thickens the near band without walling it off, so
      // the wood thins into the middle distance instead of stopping dead.
      falloff: 0.45,
      spacing: 6.4,
      clearance: 11,
    },
    plan.keepOut,
    (hit) => {
      const r = rng() * acc;
      let si = 0;
      while (si < cw.length - 1 && r > cw[si]) si++;
      const sp = species[si];
      const k = kinds[si];
      const sector = sampler.sectorOf(hit.t);
      const scale = rand(rng, sp.scale[0], sp.scale[1]);
      // Slightly taller than wide, varied per tree: uniform scaling makes a
      // wood of clones, and the y stretch is the cheapest tell to break.
      const stretch = scale * rand(rng, 0.94, 1.14);
      const yaw = rng() * TAU;

      // Trunk and canopy get the *same* tint so a tree is one plant, and the
      // tint drifts yellow-green to blue-green so the wood has depth.
      const warm = rand(rng, -0.09, 0.09);
      tint.setRGB(1 + warm, 1 + Math.abs(warm) * 0.25, 1 - warm);
      place(k.trunk, sector, hit.x, hit.y, hit.z, yaw, scale, stretch, tint);
      place(k.canopy, sector, hit.x, hit.y, hit.z, yaw, scale, stretch, tint);
    },
  );

  // --- bushes --------------------------------------------------------------
  scatter(
    sampler,
    b.rng("flora/bushes"),
    { count: density.bushes, minOffset: 5.5, maxOffset: 46, falloff: 0.8, spacing: 3.0, clearance: 5.0 },
    plan.keepOut,
    (hit) => {
      const warm = rand(rng, -0.1, 0.08);
      tint.setRGB(1 + warm, 1 + Math.abs(warm) * 0.2, 1 - warm * 1.2);
      place(
        kBush,
        sampler.sectorOf(hit.t),
        hit.x,
        hit.y,
        hit.z,
        rng() * TAU,
        rand(rng, 0.7, 1.5),
        rand(rng, 0.65, 1.3),
        tint,
      );
    },
  );

  // --- grass layer ---------------------------------------------------------
  if (density.tufts > 0) {
    scatter(
      sampler,
      b.rng("flora/tufts"),
      // Right up against the road: this layer exists to hide the seam where the
      // tarmac meets the verge, which is the one edge a driver stares at.
      { count: density.tufts, minOffset: 0.1, maxOffset: 9, falloff: 0.6, spacing: 1.15, clearance: 0.05 },
      plan.keepOut,
      (hit) => {
        const dry = rand(rng, -0.12, 0.1);
        tint.setRGB(1 + dry * 1.4, 1 + dry * 0.4, 1 - dry * 1.6);
        place(
          kTuft,
          sampler.sectorOf(hit.t),
          hit.x,
          hit.y - 0.04,
          hit.z,
          rng() * TAU,
          rand(rng, 0.7, 1.35),
          rand(rng, 0.7, 1.5),
          tint,
        );
      },
    );
  }

  return {};
}

export const FLORA_HEIGHTS = { BROADLEAF_H, CONIFER_H, PALM_H };
