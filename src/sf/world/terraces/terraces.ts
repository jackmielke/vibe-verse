/**
 * terraces.ts — The Terraces, on Twin Peaks.
 *
 * Somebody has terraced the top of Twin Peaks into a stepped garden mountain
 * and painted the whole thing in watercolour. Seven levels rise a hundred and
 * ten metres above the summit — red earth and a geodesic dome at the bottom, a
 * pagoda beside a turquoise pool, vineyard rows, one enormous tree with a
 * table under it, a scale model of San Francisco, a snow line, and a pavilion
 * at the top at 418 m, which is ninety metres above the Salesforce Tower and
 * visible from most of the east side of the city.
 *
 * ## Why here
 *
 * Twin Peaks is the one place in this world that is already about looking at
 * the rest of it, it is already excluded from the procedural builder, and — as
 * it turns out when you sample the terrain — it is not a peak at all but a
 * broad plateau that falls twenty metres in four hundred. So there is a flat
 * six-hectare site at 292 m in the middle of San Francisco with nothing on it,
 * which is exactly the thing this needed and is not a coincidence: the real
 * hill is the reason the real city left it empty.
 *
 * ## How it is built
 *
 * Every level is a lofted band between two rings, and every ring is a circle
 * with two low harmonics added to its radius, so nothing is truly round and
 * the plan reads as drawn rather than as revolved. The levels do not share a
 * centre: each one steps *away* from downtown as it rises, so the terraces
 * fan open toward the city and the whole mountain has a front.
 *
 * The bottom skirt is the only part that touches the real world, and it does
 * it per-vertex: its lower ring is sampled against the terrain, so the
 * structure meets the hill wherever the hill happens to be instead of
 * floating on an assumption about it.
 *
 * ## The look
 *
 * `watercolour.ts` does the actual painting; the geometry only has to give it
 * shapes worth washing. Two rules were followed throughout and are worth
 * keeping: **no right angles that did not have to be right angles**, and
 * **eight colours, not twenty**. A watercolour is recognisable because
 * everything in it came out of the same small box of pans.
 */
import * as THREE from "three";
import type { LandmarkCtx, LandmarkModule } from "../landmarks/types";
import type { LandmarkDef } from "../../geo/sfGeo";
import {
  box, circleRing, lathe, loft, rectRing, ribbon, strut, taperBox, tube, xform,
} from "../landmarks/kit";
import { WASH, watercolour } from "./watercolour";

/* ================================================================== *
 * The plan
 * ================================================================== */

/** One terrace. `y` is metres above the summit; `r` is its mean radius. */
interface Level {
  y: number;
  r: number;
  /** How far this level's centre steps back from downtown, metres. */
  back: number;
}

/**
 * Seven levels, bottom to top.
 *
 * The radii fall faster than the heights rise, which is what makes it read as
 * a mountain rather than a wedding cake: each step in is bigger than the step
 * up, so the profile is concave.
 */
const LEVELS: readonly Level[] = [
  { y: 16, r: 190, back: 0 },
  { y: 38, r: 152, back: 9 },
  { y: 60, r: 118, back: 19 },
  { y: 82, r: 88, back: 29 },
  { y: 104, r: 62, back: 38 },
  { y: 126, r: 40, back: 46 },
  { y: 148, r: 22, back: 52 },
];

/**
 * The bearing the terraces open toward, in the local XZ frame.
 *
 * Twin Peaks is at (−4073, 4364) and downtown is up and to the right of that
 * — east and north — so this is roughly −39°, and every level steps the
 * opposite way. Get this wrong and the mountain turns its back on the city,
 * which is the only view anybody is here for.
 */
const FACE = -0.68;
const FACE_X = Math.cos(FACE);
const FACE_Z = Math.sin(FACE);

/** Radius of a level at an angle. Two harmonics, no more — three reads noisy. */
function radiusAt(level: number, theta: number): number {
  const L = LEVELS[level];
  const wob =
    1
    + 0.085 * Math.sin(theta * 3 + level * 1.9)
    + 0.045 * Math.sin(theta * 5 - level * 0.7);
  return L.r * wob;
}

function centreX(level: number): number {
  return -LEVELS[level].back * FACE_X;
}
function centreZ(level: number): number {
  return -LEVELS[level].back * FACE_Z;
}

/** A ring around a level, at a given elevation. */
function levelRing(level: number, y: number, seg: number, scale = 1): Float32Array {
  const out = new Float32Array(seg * 3);
  const cx = centreX(level);
  const cz = centreZ(level);
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    const r = radiusAt(level, a) * scale;
    out[i * 3] = cx + Math.cos(a) * r;
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = cz + Math.sin(a) * r;
  }
  return out;
}

/**
 * Reverse a ring's vertex order, for handing to `loft`.
 *
 * `loft` triangulates consecutive rings as (r,i) (r,j) (r+1,j), so the normal
 * it computes depends on which way round the ring is wound — and every ring
 * builder in `kit.ts` (`circleRing`, `rectRing`, `shapedRing`) winds
 * anticlockwise in XZ, which comes out pointing **inward**. Most of the
 * landmark directory gets away with that because it lofts into materials that
 * are double-sided or nearly matte, and three flips the normal on a back face
 * for a `DoubleSide` material anyway.
 *
 * The watercolour materials are single-sided, because the whole look depends
 * on the fresnel term and a flipped normal ruins it — so here it matters, and
 * it matters spectacularly: the first build of this mountain had every wall
 * inside out, which reads not as an obvious error but as a pale, oddly lit
 * solid with black patches where you happened to be seeing its interior.
 *
 * Reversed rings give outward normals. `terraces.test.ts` pins it.
 */
function out(ring: Float32Array): Float32Array {
  const n = ring.length / 3;
  const r = new Float32Array(ring.length);
  for (let i = 0; i < n; i++) {
    const src = (n - 1 - i) * 3;
    r[i * 3] = ring[src];
    r[i * 3 + 1] = ring[src + 1];
    r[i * 3 + 2] = ring[src + 2];
  }
  return r;
}

/**
 * A flat horizontal band between two rings, normals pointing up.
 *
 * Not `loft()`, and the reason is the first thing that went wrong here. `loft`
 * derives its normals from the order of the rings, which is exactly right for
 * a wall — bottom ring, top ring, normals outward — and ambiguous for two
 * rings at the *same* elevation. Every terrace deck came out facing downwards,
 * so the top of the mountain was lit from underneath and rendered as a stack
 * of black discs: a perfectly built model, correctly placed, invisible.
 *
 * Winding: triangle (outer[i], inner[i], outer[i+1]) has a +Y normal when the
 * inner ring is inside the outer one and both are wound the same way, which
 * every ring in this file is.
 */
function deck(outer: Float32Array, inner: Float32Array): THREE.BufferGeometry {
  const n = outer.length / 3;
  const pos = new Float32Array(n * 2 * 3);
  pos.set(outer, 0);
  pos.set(inner, n * 3);
  const nor = new Float32Array(n * 2 * 3);
  for (let i = 0; i < n * 2; i++) nor[i * 3 + 1] = 1;
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    idx.push(i, n + i, j, j, n + i, n + j);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(n * 4), 2));
  g.setIndex(idx);
  return g;
}

/** A point on a level's deck, in polar coordinates about that level's centre. */
function onLevel(level: number, theta: number, frac: number): { x: number; z: number } {
  const r = radiusAt(level, theta) * frac;
  return { x: centreX(level) + Math.cos(theta) * r, z: centreZ(level) + Math.sin(theta) * r };
}

/* ================================================================== *
 * The structure
 * ================================================================== */

/**
 * The stepped cone: a retaining wall and a deck for each level.
 *
 * The lowest wall is the only one that has to negotiate with reality. Its
 * lower ring is sampled against the terrain and pushed four metres under it,
 * so the mountain is seated in the hill at every angle rather than at the one
 * angle somebody measured.
 */
function buildStructure(ctx: LandmarkCtx, g0: number, seg: number): void {
  const { batch } = ctx;

  /* One wash per level, bottom to top, and this list is the whole colour
     design: red earth at the foot, ochre through the planted middle, bare
     paper above the tree line, and snow. Reading the mountain's height off
     its colour is what the painting does and it is why a single stone would
     have been a much worse building. */
  const WALLS = [
    WASH.earth(), WASH.earth(), WASH.ochre(),
    WASH.path(), WASH.path(), WASH.snowShade(), WASH.snowShade(),
  ];
  /* One bucket for every buttress on the mountain — a hundred and fifty
     boxes in a single draw. */
  const rib = batch.instances(WASH.rib(), box(1, 1, 1));

  const DECKS = [
    WASH.earthDeck(), WASH.terrace(), WASH.vineDeck(),
    WASH.terrace(), WASH.plaster(), WASH.snow(), WASH.snow(),
  ];

  for (let i = 0; i < LEVELS.length; i++) {
    const top = g0 + LEVELS[i].y;
    const outer = levelRing(i, top, seg);

    /* ---- the retaining wall under this deck ----
       Battered: 4 % wider at the foot than at the top. Every retaining wall
       ever built leans back into the hill it is holding up, and the reason to
       bother is not authenticity — it is that a dead-vertical 22 m cylinder
       catches exactly one shade of light over its whole height and reads as a
       cardboard tube. A batter gives it a gradient. */
    let lower: Float32Array;
    if (i === 0) {
      lower = levelRing(0, 0, seg, 1.04);
      for (let k = 0; k < seg; k++) {
        lower[k * 3 + 1] = ctx.ground(lower[k * 3], lower[k * 3 + 2]) - 4;
      }
    } else {
      // Sits on the deck below, slightly proud of it so the two do not z-fight
      // along a shared edge.
      lower = levelRing(i, g0 + LEVELS[i - 1].y - 0.4, seg, 1.04);
    }
    batch.add(WALLS[i], loft([out(lower), out(outer)], false, false));

    /* ---- buttresses ----
       Ribs every fifteen degrees. They are what give the wall a scale: without
       them a hundred-metre terrace and a ten-metre one are the same picture.

       Each one is a bar from the foot of the wall to its top, following the
       batter. That matters more than it sounds: an upright rib on a wall that
       leans out 4 % over 190 m of radius is buried by seven metres of masonry
       at the bottom and only pokes out at the very top, which reads as a row
       of little pale wedges hanging off the parapet — which is exactly what
       the first version looked like. `strut()` maps a unit box onto the line
       between two points, so following the lean costs nothing. */
    if (seg >= 48) {
      const ribs = 24;
      for (let k = 0; k < ribs; k++) {
        const a = ((k + 0.35) / ribs) * Math.PI * 2;
        const cosA = Math.cos(a);
        const sinA = Math.sin(a);
        const r = radiusAt(i, a);
        const xTop = centreX(i) + cosA * (r + 1.1);
        const zTop = centreZ(i) + sinA * (r + 1.1);
        const xBot = centreX(i) + cosA * (r * 1.04 + 1.1);
        const zBot = centreZ(i) + sinA * (r * 1.04 + 1.1);
        const y0 = i === 0 ? ctx.ground(xBot, zBot) : g0 + LEVELS[i - 1].y;
        if (top - y0 < 3) continue;
        rib.at(strut(xBot, y0, zBot, xTop, top + 0.9, zTop, 2.8, 3.4));
      }
    }

    /* ---- the deck ---- */
    // Everything from this level's edge in to the next level's wall. The top
    // level is capped solid instead.
    const inner = i === LEVELS.length - 1
      ? levelRing(i, top, seg, 0.001)
      : levelRing(i + 1, top, seg, 1.0);
    batch.add(DECKS[i], deck(outer, inner));

    /* ---- a low parapet, so the edge reads and you can lean on it ---- */
    if (seg >= 48) {
      const lip = levelRing(i, top + 0.9, seg);
      const lipIn = levelRing(i, top + 0.9, seg, 0.986);
      const deckIn = levelRing(i, top, seg, 0.986);
      // Outer face, inner face, and a flat coping across the top of the wall.
      batch.add(WALLS[i], loft([out(outer), out(lip)], false, false));
      batch.add(WALLS[i], loft([out(deckIn), out(lipIn)], false, false));
      batch.add(WASH.path(), deck(lip, lipIn));
    }
  }
}

/** True if a point (in the local frame) is inside a level's outline. */
function insideLevel(level: number, x: number, z: number): boolean {
  const dx = x - centreX(level);
  const dz = z - centreZ(level);
  return Math.hypot(dx, dz) < radiusAt(level, Math.atan2(dz, dx));
}

/**
 * Colliders: an annulus of boxes per level, so the decks are somewhere you can
 * actually stand.
 *
 * Boxes rather than a mesh because that is what the landmark collider system
 * takes, and sectors rather than one big box because these terraces are round
 * and a square collider would leave you standing on four corners of nothing.
 *
 * The inner edge of each annulus is *measured*, not assumed. The levels do not
 * share a centre — that is the whole reason the mountain has a front — so the
 * gap between level 4's outer ring and level 5's is a lune, not a ring, and a
 * concentric approximation leaves a hole in the widest part of every deck,
 * which is exactly the part people stand on.
 */
function buildColliders(ctx: LandmarkCtx, g0: number): void {
  const SECTORS = 24;
  for (let i = 0; i < LEVELS.length; i++) {
    const top = g0 + LEVELS[i].y;
    const cx = centreX(i);
    const cz = centreZ(i);
    for (let s = 0; s < SECTORS; s++) {
      const a = ((s + 0.5) / SECTORS) * Math.PI * 2;
      const rOut = radiusAt(i, a);
      // March inward until the ray crosses into the level above.
      let rIn = 0;
      if (i < LEVELS.length - 1) {
        for (let r = rOut; r > 0; r -= 1.5) {
          if (insideLevel(i + 1, cx + Math.cos(a) * r, cz + Math.sin(a) * r)) {
            rIn = r;
            break;
          }
        }
      }
      const rm = (rIn + rOut) / 2;
      const half = Math.max(2, (rOut - rIn) / 2);
      // Arc half-length at the mid radius, plus a little overlap so a player
      // walking the seam between two sectors never finds a gap.
      const arc = (Math.PI / SECTORS) * rm + 1.4;
      /* `-a`, not `a`. `landmarkSurfaceHeight` — the "what am I standing on"
         query, which is the whole reason these exist — rotates world into box
         space by `+yaw`, so a box whose long axis points outward along `a`
         has to be declared at `-a`. (`Walker`'s push-out uses the opposite
         sign, which is a disagreement that predates this file and only shows
         up on colliders that are not axis-aligned. Terraces never overhang
         anything, so nothing is ever under one of these boxes to be pushed.) */
      ctx.collide.box(
        cx + Math.cos(a) * rm,
        top - 1.2,
        cz + Math.sin(a) * rm,
        half, 1.2, arc,
        -a,
        { walkable: true, drivable: false },
      );
    }
  }
}

/**
 * The switchback path: one continuous pale ribbon from the foot of the
 * mountain to the pavilion, doubling back on itself at every level.
 *
 * A staircase would be easier and would be wrong. The path in the painting is
 * the thing that gives the mountain its scale — it is the only element that
 * tells you the terraces are hundreds of metres across rather than tens — and
 * a switchback does that because you can see how long it is.
 */
function buildPath(ctx: LandmarkCtx, g0: number, detail: boolean): void {
  const pts: THREE.Vector3[] = [];
  const steps = detail ? 9 : 4;

  // Start out on the hill below the base, so it arrives from the city rather
  // than beginning nowhere.
  const startA = FACE;
  const s0 = onLevel(0, startA, 1.28);
  pts.push(new THREE.Vector3(s0.x, ctx.ground(s0.x, s0.z) + 0.4, s0.z));

  for (let i = 0; i < LEVELS.length; i++) {
    const yTop = g0 + LEVELS[i].y + 0.5;
    const yBot = i === 0 ? ctx.ground(s0.x, s0.z) + 0.4 : g0 + LEVELS[i - 1].y + 0.5;
    // Alternate direction each level: that is what makes it a switchback and
    // not a spiral, and a spiral around a 200 m terrace is a ten-minute walk.
    const dir = i % 2 === 0 ? 1 : -1;
    const a0 = startA - dir * 0.55;
    const a1 = startA + dir * 0.75;
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      const a = a0 + (a1 - a0) * t;
      const frac = 1.02 - 0.06 * Math.sin(t * Math.PI);
      const p = onLevel(i, a, frac);
      pts.push(new THREE.Vector3(p.x, yBot + (yTop - yBot) * t, p.z));
    }
  }

  ctx.batch.add(WASH.path(), ribbon(pts, 3.4, 0.7));
  ctx.collide.ribbon(pts, 3.4, 0.7, { walkable: true, drivable: true });

  if (!detail) return;

  /* Lanterns down one side. They are the reason this place is worth walking
     up after dark, and they cost one instanced draw. */
  const lantern = ctx.batch.instances(WASH.lantern(), lathe([0, 0, 0.34, 0.16, 0.4, 0.5, 0.2, 0.8, 0, 0.86], 8));
  const post = ctx.batch.instances(WASH.timber(), box(0.13, 1.5, 0.13));
  for (let k = 2; k < pts.length; k += 2) {
    const p = pts[k];
    const q = pts[k - 1];
    const dx = p.x - q.x;
    const dz = p.z - q.z;
    const len = Math.hypot(dx, dz) || 1;
    // Offset to the outside of the ribbon.
    const ox = (-dz / len) * 4.4;
    const oz = (dx / len) * 4.4;
    post.atPos(p.x + ox, p.y + 0.75, p.z + oz);
    lantern.atPos(p.x + ox, p.y + 1.5, p.z + oz, ctx.rng.range(0, 6.28));
  }
}

/* ================================================================== *
 * Level 0 — red earth, the dome, the solar array
 * ================================================================== */

function buildDome(ctx: LandmarkCtx, g0: number, detail: boolean): void {
  const { batch } = ctx;
  const y = g0 + LEVELS[0].y;
  const p = onLevel(0, FACE + 0.95, 0.72);
  const R = 21;

  /* A geodesic sphere half-buried in the deck. Half-buried rather than a true
     hemisphere because an icosahedron subdivided twice has no equator to cut
     along, and forcing one gives a ragged rim; sinking it gives a clean one
     for free where it meets the terrace. */
  const shell = new THREE.IcosahedronGeometry(R, detail ? 2 : 1);
  batch.add(
    watercolour("dome-panels", { color: 0xe8e1d0, wash: 0.5, grain: 0.16, steps: 3, flatShading: true }),
    shell,
    xform(p.x, y + R * 0.36, p.z, 0, 0, 0, 1, 0.82, 1),
  );
  // The frame, a hair proud of the panels. A wireframe pass is exactly the
  // right primitive here for once: geodesic frames *are* their edges.
  batch.add(
    watercolour("dome-frame", { color: 0x9aa0a2, wash: 0.4, grain: 0.1, steps: 3, wireframe: true }),
    new THREE.IcosahedronGeometry(R * 1.006, detail ? 2 : 1),
    xform(p.x, y + R * 0.36, p.z, 0, 0, 0, 1, 0.82, 1),
  );
  ctx.collide.box(p.x, y + R * 0.3, p.z, R * 0.8, R * 0.3, R * 0.8, 0, { walkable: false });

  if (!detail) return;

  /* The solar array, downslope of the dome and tilted south — which in this
     frame is +Z, and is the only reason the tilt is worth getting right: a
     field of panels facing the wrong way is a detail nobody can name and
     everybody can feel. */
  const panel = batch.instances(WASH.solar(), box(3.4, 0.14, 2.0));
  const frame = batch.instances(WASH.strut(), box(0.12, 0.9, 0.12));
  for (let row = 0; row < 7; row++) {
    for (let col = 0; col < 9; col++) {
      const a = FACE + 1.55 + col * 0.055;
      const q = onLevel(0, a, 0.5 + row * 0.058);
      const yaw = a + Math.PI / 2;
      panel.atPos(q.x, y + 1.5, q.z, yaw, -0.52);
      frame.atPos(q.x, y + 0.45, q.z, yaw);
    }
  }
}

/* ================================================================== *
 * Level 1 — the pagoda, the pool, the palms
 * ================================================================== */

/**
 * One flared, upturned-eaved roof.
 *
 * The rings run strictly bottom to top, and they have to. `loft` derives its
 * normals from consecutive rings, so a ring list that goes back down — which
 * is the obvious way to describe an eave that turns up at its outer edge —
 * flips the normals on that band and the roof renders black. Describe the
 * upturn as the *lowest* ring being the widest instead: same shape, and it is
 * lit.
 */
function pagodaRoof(w: number, h: number): THREE.BufferGeometry {
  return loft(
    [
      out(rectRing(w * 1.16, w * 1.16, -0.55)),
      out(rectRing(w * 0.94, w * 0.94, 0.35)),
      out(rectRing(w * 0.62, w * 0.62, h * 0.62)),
      out(rectRing(w * 0.14, w * 0.14, h)),
    ],
    true,
    true,
  );
}

function buildPagoda(ctx: LandmarkCtx, g0: number, detail: boolean): void {
  const { batch } = ctx;
  const y = g0 + LEVELS[1].y;
  const p = onLevel(1, FACE + 0.5, 0.66);
  const tile = WASH.tile();
  const red = WASH.vermilion();
  const timber = WASH.timber();

  // Plinth.
  batch.add(WASH.path(), taperBox(15, 1.4, 15, 13.6, 13.6), xform(p.x, y + 0.7, p.z));

  let ty = y + 1.4;
  const tiers = detail ? 3 : 2;
  for (let t = 0; t < tiers; t++) {
    const w = 11.5 - t * 2.6;
    const bodyH = 4.6 - t * 0.5;
    batch.add(red, taperBox(w, bodyH, w, w * 0.94, w * 0.94), xform(p.x, ty + bodyH / 2, p.z));
    if (detail) {
      // Corner posts, which is most of what you see of a pagoda from below.
      const post = batch.instances(timber, box(0.34, bodyH, 0.34));
      for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
        post.atPos(p.x + sx * w * 0.46, ty + bodyH / 2, p.z + sz * w * 0.46);
      }
    }
    ty += bodyH;
    batch.add(tile, pagodaRoof(w, 2.6), xform(p.x, ty, p.z, t * 0.05));
    ty += 1.5;
  }
  // The finial.
  batch.add(WASH.strut(), lathe([0, 0, 0.5, 0.4, 0.22, 1.4, 0.5, 1.9, 0.1, 3.2, 0, 3.5], 8),
    xform(p.x, ty, p.z));
  ctx.collide.box(p.x, y + 4, p.z, 6.5, 4, 6.5, 0, { walkable: false });

  /* ---- the pool ----
     The one saturated thing on the mountain, and the reason the whole level
     works: everything else here is a wash of ochre and olive, so a single
     turquoise disc carries the entire painting. */
  const pool = onLevel(1, FACE - 0.55, 0.6);
  const seg = detail ? 40 : 16;
  const rim: Float32Array[] = [];
  const wobble = (a: number) => 21 * (1 + 0.12 * Math.sin(a * 3 + 0.9) + 0.06 * Math.sin(a * 5));
  const ring = (r: number, yy: number) => {
    const out = new Float32Array(seg * 3);
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      out[i * 3] = pool.x + Math.cos(a) * wobble(a) * r;
      out[i * 3 + 1] = yy;
      out[i * 3 + 2] = pool.z + Math.sin(a) * wobble(a) * r;
    }
    return out;
  };
  // Basin: a lip, a wall down, and the water surface just under the lip.
  // Top to bottom, so `out()` is not wanted: the basin is seen from inside.
  rim.push(ring(1.06, y + 0.5), ring(1.0, y + 0.35), ring(0.98, y - 2.4), ring(0.2, y - 3.0));
  batch.add(WASH.path(), loft(rim, false, true));
  batch.add(
    watercolour("pool-water", { color: 0x37b0ad, wash: 0.14, grain: 0.3, edge: 0.7, steps: 5, roughness: 0.22, opacity: 0.88 }),
    deck(ring(0.97, y + 0.1), ring(0.001, y + 0.1)),
  );

  if (!detail) return;

  /* ---- banana palms ----
     Crossed cards, not modelled fronds. A banana leaf is a flat blade with a
     torn edge and reads perfectly as a quad from any distance you can get to
     it here, and the alternative is four hundred triangles per plant for a
     silhouette nobody can tell apart. */
  const frond = batch.instances(WASH.frond(), box(6.4, 0.08, 1.5));
  const stem = batch.instances(WASH.timber(), taperBox(0.6, 3.4, 0.6, 0.35, 0.35));
  for (let i = 0; i < 14; i++) {
    const a = ctx.rng.range(0, Math.PI * 2);
    const d = 1.28 + ctx.rng.range(0, 0.22);
    const q = {
      x: pool.x + Math.cos(a) * wobble(a) * d,
      z: pool.z + Math.sin(a) * wobble(a) * d,
    };
    stem.atPos(q.x, y + 1.7, q.z);
    for (let f = 0; f < 6; f++) {
      const fa = ctx.rng.range(0, 6.28);
      frond.atPos(
        q.x + Math.cos(fa) * 2.6, y + 3.4 + ctx.rng.range(-0.3, 0.5), q.z + Math.sin(fa) * 2.6,
        fa, ctx.rng.range(-0.5, -0.1), 0, ctx.rng.range(0.75, 1.15),
      );
    }
  }

  /* A stone monkey on the pool coping, because there is one in the painting
     and because a place is more memorable for one odd specific thing than for
     ten tasteful ones. */
  const mk = { x: pool.x + wobble(0.4) * Math.cos(0.4) * 1.05, z: pool.z + wobble(0.4) * Math.sin(0.4) * 1.05 };
  const stone = watercolour("monkey", { color: 0xcfc4ad, wash: 0.44, grain: 0.2, steps: 3, flatShading: true });
  batch.add(stone, new THREE.IcosahedronGeometry(0.5, 1), xform(mk.x, y + 1.55, mk.z));
  batch.add(stone, taperBox(0.7, 1.0, 0.5, 0.5, 0.4), xform(mk.x, y + 0.9, mk.z, 0.6));
  batch.add(stone, box(0.9, 0.16, 0.9), xform(mk.x, y + 0.45, mk.z, 0.6));
}

/* ================================================================== *
 * Level 2 — the vineyard
 * ================================================================== */

function buildVineyard(ctx: LandmarkCtx, g0: number, detail: boolean): void {
  const { batch } = ctx;
  const y = g0 + LEVELS[2].y;
  const rows = detail ? 11 : 5;
  /* Long along the row, not cubes. A vine is trained on a wire and grows into
     a continuous hedge; a grid of separate blocks reads as a car park. The
     geometry is 5 m of row per instance and they are placed to overlap. */
  const vine = batch.instances(WASH.vine(), box(1.3, 1.9, 5));
  const post = detail ? batch.instances(WASH.timber(), box(0.11, 2.3, 0.11)) : null;

  /* Rows follow the contour rather than the fall line, which is how a hillside
     vineyard is actually planted — and it is also what makes the terrace read
     as curved from a distance, because the rows draw its plan for you. */
  for (let r = 0; r < rows; r++) {
    const frac = 0.42 + (r / rows) * 0.54;
    const span = 2.3;
    const n = detail ? 52 : 18;
    for (let k = 0; k <= n; k++) {
      const a = FACE - span / 2 + (span * k) / n + r * 0.03;
      const q = onLevel(2, a, frac);
      /* `-a`, so the box's long axis (local +Z) lands on the tangent: a three
         yaw of θ sends local +Z to (sin θ, 0, cos θ), and the tangent at angle
         `a` is (−sin a, 0, cos a). */
      vine.atPos(q.x, y + 1.1, q.z, -a, 0, 0, 1, ctx.rng.range(0.85, 1.2), 1);
      if (post && k % 6 === 0) post.atPos(q.x, y + 1.15, q.z, -a);
    }
  }
}

/* ================================================================== *
 * Level 3 — the great tree and the table under it
 * ================================================================== */

function buildGreatTree(ctx: LandmarkCtx, g0: number, detail: boolean): void {
  const { batch } = ctx;
  const y = g0 + LEVELS[3].y;
  const p = onLevel(3, FACE + 0.12, 0.52);
  const canopy = WASH.canopy();
  const timber = WASH.timber();

  batch.add(timber, taperBox(3.6, 11, 3.6, 2.0, 2.0), xform(p.x, y + 5.5, p.z));

  /* Three overlapping squashed spheres, not one — a single ellipsoid reads as
     a lollipop, and the thing that makes a big old tree look big and old is
     that its crown is several crowns that grew into each other. */
  const blobs: [number, number, number, number][] = [
    [0, 12.5, 0, 15],
    [8.5, 10.5, 3.5, 10.5],
    [-7.5, 11.5, -4.5, 11],
    [2.5, 9.0, -9.0, 9],
  ];
  for (const [dx, dy, dz, r] of blobs) {
    batch.add(
      canopy,
      new THREE.IcosahedronGeometry(r, detail ? 2 : 1),
      xform(p.x + dx, y + dy, p.z + dz, ctx.rng.range(0, 3), 0, 0, 1, 0.62, 1),
    );
  }
  ctx.collide.box(p.x, y + 5, p.z, 2, 5, 2, 0, { walkable: false });

  if (!detail) return;

  // The table. Long, laid, and under the widest part of the crown.
  const t = { x: p.x + 6, z: p.z + 7 };
  batch.add(WASH.plaster(), box(7.5, 0.18, 2.2), xform(t.x, y + 0.95, t.z, 0.4));
  const leg = batch.instances(timber, box(0.16, 0.95, 0.16));
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
    leg.atPos(t.x + sx * 3.4 * Math.cos(0.4) - sz * 0.9 * Math.sin(0.4), y + 0.48,
              t.z + sx * 3.4 * Math.sin(0.4) + sz * 0.9 * Math.cos(0.4));
  }
  const chair = batch.instances(timber, box(0.5, 0.9, 0.5));
  for (let i = 0; i < 8; i++) {
    const s = i < 4 ? 1 : -1;
    const along = (i % 4) * 1.9 - 2.85;
    chair.atPos(
      t.x + along * Math.cos(0.4) - s * 1.7 * Math.sin(0.4), y + 0.45,
      t.z + along * Math.sin(0.4) + s * 1.7 * Math.cos(0.4), 0.4,
    );
  }
  // Lanterns strung into the branches.
  const lantern = batch.instances(WASH.lantern(), lathe([0, 0, 0.3, 0.2, 0.34, 0.55, 0, 0.75], 8));
  for (let i = 0; i < 16; i++) {
    const a = ctx.rng.range(0, 6.28);
    const d = ctx.rng.range(4, 13);
    lantern.atPos(p.x + Math.cos(a) * d, y + ctx.rng.range(5.5, 9), p.z + Math.sin(a) * d);
  }
}

/* ================================================================== *
 * Level 4 — a model of the city, seen from above it
 * ================================================================== */

/**
 * San Francisco, 1:110, on a plinth, four hundred metres up and eight
 * kilometres from the real thing — which is in frame behind it.
 *
 * This is the piece the whole district is built around. The joke only lands
 * because the model is accurate: the Transamerica is a spike, the Salesforce
 * Tower is taller and rounder, Coit is a stub on its own hill, and the Golden
 * Gate is orange and has a real catenary. Get any of those wrong and it is
 * just some blocks on a table.
 */
function buildModelCity(ctx: LandmarkCtx, g0: number, detail: boolean): void {
  const { batch } = ctx;
  const y = g0 + LEVELS[4].y;
  const p = onLevel(4, FACE, 0.42);
  const S = 1 / 110;
  const stone = WASH.model();
  const orange = WASH.modelOrange();

  // The plinth is a low relief of the peninsula: a rounded slab, tilted a
  // couple of degrees so it faces somebody standing on the uphill side.
  batch.add(WASH.plaster(), taperBox(26, 1.1, 20, 24, 18), xform(p.x, y + 0.55, p.z, FACE));
  batch.add(stone, taperBox(24, 0.5, 18, 23, 17), xform(p.x, y + 1.3, p.z, FACE));

  const base = y + 1.55;
  const at = (dx: number, dz: number) => ({
    x: p.x + dx * Math.cos(FACE) - dz * Math.sin(FACE),
    z: p.z + dx * Math.sin(FACE) + dz * Math.cos(FACE),
  });

  /* The towers. Heights are the real ones scaled; the plan positions are
     compressed toward the middle, because the real city is 12 km long and the
     plinth is 26 m and a faithful layout would put the bridge off the table. */
  const towers: Array<[number, number, number, number, number]> = [
    // dx, dz, height (m, real), base width (m, real), taper to
    [3.0, -2.0, 260, 44, 0.02],   // Transamerica — a spike
    [4.4, -0.4, 326, 52, 0.55],   // Salesforce
    [3.4, 0.9, 197, 34, 0.9],     // Millennium
    [5.0, -1.6, 237, 40, 0.85],   // 555 California
    [1.4, -4.2, 64, 18, 0.8],     // Coit, on its hill
    [-1.0, 1.5, 94, 40, 0.7],     // City Hall's dome drum
  ];
  for (const [dx, dz, h, w, taper] of towers) {
    const q = at(dx, dz);
    const hh = h * S * 3.4;   // The scale is exaggerated 3.4× in height only:
    const ww = w * S * 3.4;   // at a true 1:110 the tallest tower is a 3 m stub
    batch.add(stone, taperBox(ww, hh, ww, ww * taper, ww * taper), xform(q.x, base + hh / 2, q.z, FACE + dx));
  }

  /* The Golden Gate: two towers, a real parabola, and hangers. Small enough
     that all of it is one merged geometry and none of it is instanced. */
  const a = at(-6.5, -5.6);
  const b = at(-6.5, -1.2);
  const towerH = 227 * S * 3.4;
  for (const q of [a, b]) {
    batch.add(orange, taperBox(0.55, towerH, 0.55, 0.36, 0.36), xform(q.x, base + towerH / 2, q.z, FACE));
  }
  const deckY = base + towerH * 0.28;
  batch.add(orange, box(0.5, 0.1, 5.6), xform((a.x + b.x) / 2, deckY, (a.z + b.z) / 2, FACE + Math.PI / 2));
  if (detail) {
    const cable: THREE.Vector3[] = [];
    for (let i = 0; i <= 16; i++) {
      const t = i / 16;
      const sag = 4 * t * (1 - t);
      cable.push(new THREE.Vector3(
        a.x + (b.x - a.x) * t,
        base + towerH * 0.96 - sag * (towerH * 0.68),
        a.z + (b.z - a.z) * t,
      ));
    }
    batch.add(orange, tube(cable, 0.045, 4, 18));
  }

  // A label, in the only alphabet a merged geometry can spell: a small plaque.
  batch.add(WASH.strut(), box(2.4, 0.06, 0.7), xform(at(0, 8.4).x, base + 0.05, at(0, 8.4).z, FACE, -0.3));
}

/* ================================================================== *
 * Levels 5–6 — the snow line and the pavilion
 * ================================================================== */

function buildSummit(ctx: LandmarkCtx, g0: number, detail: boolean): void {
  const { batch } = ctx;
  const y = g0 + LEVELS[6].y;
  const cx = centreX(6);
  const cz = centreZ(6);
  const tile = WASH.tile();
  const plaster = WASH.plaster();

  // Eight columns and a roof: open on every side, because the entire reason
  // to climb this is to look off it.
  const R = 13;
  const colH = 7.4;
  const col = batch.instances(plaster, lathe([0.92, 0, 0.78, 0.5, 0.68, colH * 0.9, 0.9, colH], 8));
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + 0.39;
    col.atPos(cx + Math.cos(a) * R, y + 0.6, cz + Math.sin(a) * R);
  }
  // A lantern hung between every pair, so it is somewhere to be after dark.
  const hang = batch.instances(WASH.lantern(), lathe([0, 0, 0.42, 0.24, 0.5, 0.66, 0, 0.95], 8));
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + 0.39 + Math.PI / 8;
    hang.atPos(cx + Math.cos(a) * (R - 0.6), y + colH - 1.1, cz + Math.sin(a) * (R - 0.6));
  }
  batch.add(plaster, loft([out(circleRing(R + 1.6, y, 8, 0.39)), out(circleRing(R + 1.6, y + 0.6, 8, 0.39))], false, true));
  batch.add(plaster, deck(circleRing(R + 1.6, y + 0.6, 8, 0.39), circleRing(0.4, y + 0.6, 8, 0.39)));
  // Bottom to top, for the reason in `pagodaRoof`.
  batch.add(
    tile,
    loft(
      [
        out(circleRing(R + 3.0, y + colH - 0.7, 8, 0.39)),
        out(circleRing(R + 2.4, y + colH + 0.4, 8, 0.39)),
        out(circleRing(R * 0.55, y + colH + 3.4, 8, 0.39)),
        out(circleRing(0.6, y + colH + 5.0, 8, 0.39)),
      ],
      false,
      true,
    ),
  );
  batch.add(WASH.strut(), lathe([0, 0, 0.45, 0.5, 0.18, 1.6, 0.5, 2.2, 0, 3.4], 8),
    xform(cx, y + colH + 5.0, cz));
  /* No collider for the roof. It is six metres above the deck, nobody can
     reach it, and marking it walkable made it the highest walkable surface at
     the summit — which is what the spawn then aimed at. The pavilion floor is
     level 6's own deck, which `buildColliders` already covers. */

  if (!detail) return;

  /* Snow, on the two top terraces. Flattened spheres rather than a shader
     term: the snow in the painting is *patchy*, sitting in the lee of things
     and blown off the exposed edges, and a uniform white cap above a line
     would be a much less interesting picture. */
  const snow = batch.instances(WASH.snow(), new THREE.IcosahedronGeometry(1, 1));
  for (const level of [5, 6]) {
    const ly = g0 + LEVELS[level].y;
    for (let i = 0; i < 60; i++) {
      const a = ctx.rng.range(0, 6.28);
      const q = onLevel(level, a, ctx.rng.range(0.15, 0.98));
      const s = ctx.rng.range(1.4, 5.5);
      snow.atPos(q.x, ly + 0.15, q.z, ctx.rng.range(0, 3), 0, 0, s, ctx.rng.range(0.1, 0.24) * s, s);
    }
  }
}

/* ================================================================== *
 * The people
 * ================================================================== */

/**
 * Painted figures on the terraces.
 *
 * Not pedestrians — the crowd system will never route up here, and it should
 * not: these are part of the picture, the way the tiny walking people in the
 * painting are. Two primitives each, one instanced draw for all of them, and
 * they do the job the crowd could not, which is to tell you at a glance how
 * big the terraces are.
 */
function buildFigures(ctx: LandmarkCtx, g0: number): void {
  const { batch, rng } = ctx;
  const body = batch.instances(
    watercolour("figure", { color: 0xffffff, wash: 0.3, grain: 0.16, steps: 3 }),
    taperBox(0.46, 1.35, 0.32, 0.4, 0.3),
  );
  const head = batch.instances(
    watercolour("figure-head", { color: 0xd9b48f, wash: 0.34, grain: 0.14, steps: 3 }),
    new THREE.IcosahedronGeometry(0.15, 1),
  );

  // Out of the same pans as everything else, so they belong to the picture.
  const COATS = [0xc2523a, 0x37b0ad, 0xe6dcc6, 0x7e9060, 0x6d7f8c, 0xb4643f, 0xf0d9a8];

  for (let i = 0; i < 34; i++) {
    const level = Math.floor(rng.range(0, LEVELS.length - 0.001));
    const y = g0 + LEVELS[level].y;
    const a = rng.range(0, Math.PI * 2);
    const q = onLevel(level, a, rng.range(0.2, 0.95));
    const yaw = rng.range(0, 6.28);
    const h = rng.range(0.92, 1.08);
    body.atPos(q.x, y + 0.68 * h, q.z, yaw, 0, 0, 1, h, 1, COATS[i % COATS.length]);
    head.atPos(q.x, y + 1.45 * h, q.z, yaw);
  }
}

/* ================================================================== *
 * The module
 * ================================================================== */

function buildTerraces(ctx: LandmarkCtx): void {
  const { detail } = ctx;
  // The summit under the anchor. Everything is measured from here, so the
  // mountain sits on the hill rather than at an elevation somebody typed.
  const g0 = ctx.ground(0, 0);
  const seg = detail ? 64 : 26;

  buildStructure(ctx, g0, seg);
  buildPath(ctx, g0, detail);
  buildDome(ctx, g0, detail);
  buildPagoda(ctx, g0, detail);
  buildSummit(ctx, g0, detail);

  /* Unconditional, and this is not a detail. Colliders are recorded from the
     *far* build — `Landmarks.tsx` passes `record: true` for lod 1 and `false`
     for lod 0, because the silhouette is built once at startup and the hero
     mesh streams in and out. Putting this behind `detail` meant the decks had
     no colliders at all, and the summit spawn dropped the player a hundred and
     forty metres through the mountain onto the hill underneath it. */
  buildColliders(ctx, g0);

  if (!detail) return;

  // Everything below here is only worth drawing when you can walk on it.
  buildVineyard(ctx, g0, detail);
  buildGreatTree(ctx, g0, detail);
  buildModelCity(ctx, g0, detail);
  buildFigures(ctx, g0);
}

export const watercolourTerraces: LandmarkModule = {
  yaw: (def: LandmarkDef) => def.rotation,
  build: buildTerraces,
  /* Built as a hero mesh from a kilometre out. It is 110 m of structure with a
     pavilion on top and the whole point is that you can see it coming. */
  nearRange: () => 1400,
  /* Never distance-culled: the silhouette is meant to be on the horizon from
     the Embarcadero, which is eight kilometres away and past every draw
     distance this game has. */
  anchor: true,
};
