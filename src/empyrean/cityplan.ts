/**
 * THE PLAN — where every street, block, lot, door and lamp post in The
 * Empyrean is, decided once, deterministically, before anything is drawn.
 *
 * ## Why this file exists at all
 *
 * The first build put sixty boxes on a disc with a golden-angle spiral. That
 * is a fine way to make a *skyline* and a hopeless way to make a *city*: there
 * were no streets, so there was nowhere for a pedestrian to walk, no address
 * for a courier to deliver to, no frontage for a shop to face, and no way for
 * two modules to agree on where anything was. Every system that came after
 * would have had to re-derive the layout, slightly differently, and they would
 * have disagreed — which is the same failure the world registry exists to stop
 * one level up.
 *
 * So: one module, pure data, no THREE, no DOM, no randomness that is not
 * seeded. Buildings, streets, props, crowds, traffic, activities and interiors
 * all read this and none of them invents geometry of its own. It is testable
 * in a millisecond and it is the reason six people can build six systems in
 * parallel without ever touching the same file.
 *
 * ## The shape of the city, and why it is radial
 *
 * Eight avenues from the middle to the rim, three ring roads crossing them,
 * and a great circular plaza — the Halo — at the centre with the Beacon
 * standing in it. Lanes fill in the outer bands where the blocks would
 * otherwise be enormous.
 *
 * A grid was the obvious first choice and it is wrong here for two reasons.
 * A square grid on a circular island wastes the rim in triangles and leaves
 * every edge block a different broken shape. And from the air — which in a
 * world with a jetpack is *most of the time* — a radial plan reads instantly:
 * you always know which way the middle is, because every street you are
 * standing on points at it. That is the whole navigational budget of a city
 * this size, spent on the one thing that matters.
 *
 * It also means the expensive query is cheap. "What am I standing on" is a
 * distance to the nearest ring radius and an arc distance to the nearest
 * avenue angle — closed form, no polygon tests, no spatial index — and it is
 * called for the player and every pedestrian every frame.
 */
import { makeRng, fbm2, type Rng } from "@/shared/proc/rng";
import { DECKS, ISLAND_Y, PLATEAU_R, PROMENADE_GAP } from "./config";

export interface Vec2 {
  x: number;
  z: number;
}

/* -------------------------------------------------------------------------
 * The armature
 * ---------------------------------------------------------------------- */

/** Radius of the Halo — the central plaza, kerb to kerb. */
export const HALO_R = 56;

/** The three ring roads, by centreline radius. */
export const RING_R = [138, 218, 288] as const;

/** The rim promenade: the last street before the parapet. */
export const RIM_R = 322;

/** Eight avenues. Angle of the first; the rest are every 45°. */
export const AVENUE_N = 8;
export const AVENUE_A0 = 0;

/** Lanes bisect the avenues, and only exist outside the first ring. */
export const LANE_N = 8;
export const LANE_A0 = Math.PI / AVENUE_N;

/** Carriageway half-widths and the sidewalk each side of them. */
export const W = {
  avenue: { half: 8, walk: 5.5 },
  ring: { half: 7, walk: 4.5 },
  lane: { half: 4.5, walk: 3.5 },
  rim: { half: 5, walk: 4 },
} as const;

/** How high a sidewalk stands over its road. */
export const KERB_H = 0.16;

/* -------------------------------------------------------------------------
 * Districts
 * ---------------------------------------------------------------------- */

export type DistrictId = "halo" | "core" | "market" | "gardens" | "rim";

export interface District {
  id: DistrictId;
  name: string;
  /** Inner and outer radius of the band this district owns. */
  r0: number;
  r1: number;
  /** Signal colour, used by the map, the HUD and the district's own lamps. */
  accent: string;
  /** One line, second person, for the "you have entered" chip. */
  blurb: string;
}

export const DISTRICTS: District[] = [
  {
    id: "halo",
    name: "The Halo",
    r0: 0,
    r1: HALO_R,
    accent: "#ffd28a",
    blurb: "The middle of everything. The Beacon is the only thing above you.",
  },
  {
    id: "core",
    name: "The Spires",
    r0: HALO_R,
    r1: RING_R[0],
    accent: "#8fd6ff",
    blurb: "Glass, all the way up. Look for the sky between the towers.",
  },
  {
    id: "market",
    name: "The Bazaar",
    r0: RING_R[0],
    r1: RING_R[1],
    accent: "#ffb35c",
    blurb: "Awnings, stalls and the smell of something frying.",
  },
  {
    id: "gardens",
    name: "The Terraces",
    r0: RING_R[1],
    r1: RING_R[2],
    accent: "#9ce8a8",
    blurb: "Low roofs and long gardens. Half the island's trees are here.",
  },
  {
    id: "rim",
    name: "The Rim",
    r0: RING_R[2],
    r1: PLATEAU_R,
    accent: "#c8a2ff",
    blurb: "The edge, and four hundred metres of nothing under it.",
  },
];

export function districtAt(r: number): District {
  for (const d of DISTRICTS) if (r < d.r1) return d;
  return DISTRICTS[DISTRICTS.length - 1];
}

/* -------------------------------------------------------------------------
 * Surface query
 * ---------------------------------------------------------------------- */

export type SurfaceKind =
  | "road"
  | "walk"
  | "plaza"
  | "lot"
  | "promenade"
  | "parapet"
  | "void";

export interface SurfaceHit {
  kind: SurfaceKind;
  /** Walkable height, or -Infinity over the void. */
  y: number;
  /** Which deck, 0 = the city. */
  deck: number;
}

const TAU = Math.PI * 2;

/** Shortest signed angular distance from `a` to the nearest multiple of `step`. */
function angleToNearest(a: number, step: number, offset: number): number {
  let d = (a - offset) % step;
  if (d < 0) d += step;
  return Math.min(d, step - d);
}

/**
 * What is under (x, z), and how high it is.
 *
 * Closed form on purpose — see the note at the top of the file. The player,
 * the camera and every pedestrian call this every frame, and a polygon soup
 * with a quadtree over it would be both slower and a thing to keep in sync.
 */
export function surfaceAt(x: number, z: number): SurfaceHit {
  const r = Math.hypot(x, z);

  /* ---- off the island entirely ---- */
  const last = DECKS[DECKS.length - 1];
  if (r > last.outer) return { kind: "void", y: -Infinity, deck: -1 };

  /* ---- the promenade rings under the rim ---- */
  if (r > PLATEAU_R) {
    for (let i = DECKS.length - 1; i >= 1; i--) {
      const d = DECKS[i];
      const inner = d.outer - d.width;
      if (r <= d.outer && r >= inner) return { kind: "promenade", y: d.y, deck: i };
      // Between two rings is the face of the step, which you cannot stand on.
      if (r < inner && r > inner - PROMENADE_GAP) {
        return { kind: "void", y: -Infinity, deck: -1 };
      }
    }
    return { kind: "void", y: -Infinity, deck: -1 };
  }

  const y0 = ISLAND_Y;

  /* ---- the rim parapet, a metre in from the edge ---- */
  if (r > PLATEAU_R - 1.4) return { kind: "parapet", y: y0, deck: 0 };

  /* ---- the Halo ---- */
  if (r < HALO_R) return { kind: "plaza", y: y0, deck: 0 };

  const a = Math.atan2(z, x);

  /* ---- rings ----
   * Ranked as a number rather than as the string itself: a `let` narrowed to
   * a literal type inside a closure stops accepting the other literals, and
   * the comparison that decides precedence becomes a type error. */
  let rank = 0; // 0 lot, 1 walk, 2 road
  const consider = (dist: number, half: number, walk: number) => {
    if (dist <= half) rank = 2;
    else if (dist <= half + walk && rank < 1) rank = 1;
  };

  for (const rr of RING_R) consider(Math.abs(r - rr), W.ring.half, W.ring.walk);
  consider(Math.abs(r - RIM_R), W.rim.half, W.rim.walk);

  /* ---- radials. Arc distance, so a lane is the same width everywhere ---- */
  const avA = angleToNearest(a, TAU / AVENUE_N, AVENUE_A0);
  consider(avA * r, W.avenue.half, W.avenue.walk);

  if (r > RING_R[0]) {
    const laA = angleToNearest(a, TAU / LANE_N, LANE_A0);
    consider(laA * r, W.lane.half, W.lane.walk);
  }

  /* ---- the apron around the Halo is plaza, not sidewalk ---- */
  if (rank === 0 && r < HALO_R + 9) return { kind: "plaza", y: y0, deck: 0 };

  const kind: SurfaceKind = rank === 2 ? "road" : rank === 1 ? "walk" : "lot";
  return { kind, y: rank === 2 ? y0 - KERB_H : y0, deck: 0 };
}

/** True where a body may stand: everything but the void and the parapet. */
export function walkableAt(x: number, z: number): boolean {
  const s = surfaceAt(x, z);
  return s.kind !== "void" && s.kind !== "parapet";
}

/* -------------------------------------------------------------------------
 * Blocks and lots
 * ---------------------------------------------------------------------- */

export type LotUse =
  | "tower"
  | "block"
  | "shop"
  | "civic"
  | "garden"
  | "pavilion"
  | "hangar";

export interface Lot {
  id: string;
  district: DistrictId;
  /** Footprint, world XZ, wound counter-clockwise. Always convex-ish. */
  poly: Vec2[];
  centroid: Vec2;
  /** Mean radius and angle — cheap sorting and district queries. */
  r: number;
  a: number;
  /** Deck the lot stands on. Always 0 for now; the rings are too narrow. */
  y: number;
  /** Eaves height above `y`. */
  height: number;
  use: LotUse;
  /**
   * The street-facing edge, as an index into `poly`. Shopfronts, doors,
   * awnings and signage all go here, and nowhere else — a shop window facing
   * the inside of a block is the single loudest tell that a city was
   * generated rather than laid out.
   */
  frontEdge: number;
  /** Outward normal of the front edge, unit. */
  frontNormal: Vec2;
  /** Midpoint of the front edge, sitting on the wall. Awnings and signage. */
  frontMid: Vec2;
  /** Length of the front edge, so an awning can span it. */
  frontLen: number;
  /**
   * The doorstep: the first point outward from `frontMid` that is actually
   * pavement.
   *
   * Not the same as the wall, and the difference matters. A block is held
   * clear of the pavement it faces and the lot is inset inside the block
   * again, so between a shopfront and the kerb there are two or three metres
   * of nothing. A courier told to deliver to the wall, or a pedestrian told to
   * walk to it, ends up standing in that dead strip with no nav node within
   * reach. The doorstep is on the pavement, where a doorstep goes.
   */
  door: Vec2;
  /** Stable 0..1, for anything that wants per-building variety. */
  seed: number;
  /** Set when a landmark claimed this lot; buildings.ts must skip it. */
  landmark?: string;
}

export interface Block {
  id: string;
  district: DistrictId;
  band: number;
  lots: Lot[];
}

function arcPoints(r: number, a0: number, a1: number, steps: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = a0 + (a1 - a0) * (i / steps);
    out.push({ x: Math.cos(a) * r, z: Math.sin(a) * r });
  }
  return out;
}

/**
 * A block as a polygon, wound counter-clockwise — and a trapezoid, not a
 * sector.
 *
 * The clearance a road needs is a fixed number of *metres*, and on a radial
 * plan that is a different number of *radians* at every radius. Applying the
 * innermost figure to the whole block — which is the obvious thing to write
 * and what the first pass did — over-clears the outer edge by the ratio of the
 * two radii. In the core that ratio is nearly two, so half of every block was
 * being thrown away as pavement that is not there, the blocks came out as thin
 * splinters, and the whole city fitted into twenty-two buildings.
 *
 * So each arc gets its own angular bounds and the sides slope. The result is
 * the shape a surveyor would actually peg out: parallel to the road on all
 * four sides.
 */
function trapezoidPoly(
  r0: number,
  r1: number,
  a0i: number,
  a1i: number,
  a0o: number,
  a1o: number,
): Vec2[] {
  const steps = Math.max(2, Math.round(((a1o - a0o) * r1) / 12));
  return [...arcPoints(r0, a0i, a1i, steps), ...arcPoints(r1, a1o, a0o, steps)];
}

function centroidOf(poly: Vec2[]): Vec2 {
  let x = 0;
  let z = 0;
  for (const p of poly) {
    x += p.x;
    z += p.z;
  }
  return { x: x / poly.length, z: z / poly.length };
}

/**
 * Which edge of a lot faces a street, and which way it faces.
 *
 * "Faces a street" is answered by *asking* — step a couple of metres off the
 * middle of each edge along its outward normal and see what `surfaceAt` says.
 * That is far more robust than reasoning about which side of a sector is which,
 * and it stays right when the lot is trimmed, split or moved.
 */
function chooseFront(poly: Vec2[], centre: Vec2): {
  edge: number;
  normal: Vec2;
  mid: Vec2;
  len: number;
  door: Vec2;
  score: number;
} {
  let bestEdge = 0;
  let bestScore = -Infinity;
  let bestNormal: Vec2 = { x: 1, z: 0 };
  let bestMid: Vec2 = { ...centre };
  let bestLen = 0;

  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const mx = (p.x + q.x) / 2;
    const mz = (p.z + q.z) / 2;
    const ex = q.x - p.x;
    const ez = q.z - p.z;
    const len = Math.hypot(ex, ez);
    if (len < 1.5) continue;
    // Outward normal: away from the centroid.
    let nx = ez / len;
    let nz = -ex / len;
    if (nx * (mx - centre.x) + nz * (mz - centre.z) < 0) {
      nx = -nx;
      nz = -nz;
    }
    /* Probed at three distances, best wins.
     *
     * One probe is not enough and the reason is a strip of dead ground: a
     * block is held a metre clear of the pavement it faces, and the lot is
     * inset inside the block again, so a single short probe lands in the gap,
     * reads "lot", and concludes the building has no street on any side. Every
     * lot in the outer bands was discarded that way. Reaching further is
     * enough — nothing but a road or a pavement is ever within seven metres of
     * a block edge, because that is how the block edges were chosen. */
    let kindScore = 0;
    for (const d of [3.2, 5.2, 7.2]) {
      const probe = surfaceAt(mx + nx * d, mz + nz * d);
      // A walk is what a front door wants; a plaza is better still; a road
      // with no pavement is a service edge and a lot is the inside of a block.
      const k =
        probe.kind === "plaza" ? 3 : probe.kind === "walk" ? 2.5 : probe.kind === "road" ? 1 : 0;
      kindScore = Math.max(kindScore, k);
    }
    if (kindScore <= 0) continue;
    const score = kindScore * 100 + len;
    if (score > bestScore) {
      bestScore = score;
      bestEdge = i;
      bestNormal = { x: nx, z: nz };
      bestMid = { x: mx, z: mz };
      bestLen = len;
    }
  }

  // Walk outward from the wall until the ground is something a person can
  // stand on. Half-metre steps: finer than the dead strip is wide.
  let door = { x: bestMid.x + bestNormal.x * 0.5, z: bestMid.z + bestNormal.z * 0.5 };
  for (let d = 1.0; d <= 9.0; d += 0.5) {
    const px = bestMid.x + bestNormal.x * d;
    const pz = bestMid.z + bestNormal.z * d;
    const k = surfaceAt(px, pz).kind;
    if (k === "walk" || k === "plaza") {
      door = { x: px, z: pz };
      break;
    }
    // A road with no pavement beside it still beats standing in a flowerbed.
    if (k === "road") door = { x: px, z: pz };
  }

  return {
    edge: bestEdge,
    normal: bestNormal,
    mid: bestMid,
    len: bestLen,
    door,
    score: bestScore,
  };
}

/** The clear band a block occupies between two streets, kerb and walk removed. */
function bandBounds(i: number): { r0: number; r1: number } {
  const inner =
    i === 0 ? HALO_R + 9 : RING_R[i - 1] + W.ring.half + W.ring.walk + 0.5;
  const outer =
    i < RING_R.length
      ? RING_R[i] - W.ring.half - W.ring.walk - 0.5
      : RIM_R - W.rim.half - W.rim.walk - 0.5;
  return { r0: inner, r1: outer };
}

/**
 * Height of a building on a lot.
 *
 * The silhouette of the whole city is this function and nothing else, so it is
 * written as one: a tall middle falling away to a low rim, with enough noise
 * that no two neighbours match and enough structure that the falloff is never
 * in doubt. The reference painting is a pyramid of glass with a flat skirt,
 * and a flat random distribution — which is what the first build had — gives
 * you a hedge.
 */
function heightFor(r: number, a: number, use: LotUse, rng: Rng): number {
  const t = Math.min(1, r / RING_R[2]);
  const centrality = Math.pow(1 - t, 1.35);
  // A slow angular wave so the skyline has ridges and saddles rather than
  // being radially symmetric, which from the air is unmistakable and awful.
  const wave = 0.5 + 0.5 * Math.sin(a * 3 + 0.7) * 0.55 + 0.25 * Math.sin(a * 5 - 2.0);
  const grain = fbm2(Math.cos(a) * r * 0.01, Math.sin(a) * r * 0.01, 3, 2, 0.5, 77);

  switch (use) {
    case "tower":
      return (70 + centrality * 360) * (0.55 + wave * 0.75) * (0.8 + grain * 0.5) * rng.range(0.85, 1.25);
    case "block":
      return (24 + centrality * 70) * (0.7 + wave * 0.5) * rng.range(0.8, 1.3);
    case "shop":
      return rng.range(9, 18);
    case "civic":
      return rng.range(22, 46);
    case "pavilion":
      return rng.range(5, 9);
    case "hangar":
      return rng.range(12, 20);
    case "garden":
      return 0;
  }
}

function useFor(band: number, rng: Rng): LotUse {
  if (band === 0) return rng.chance(0.88) ? "tower" : "civic";
  if (band === 1) return rng.chance(0.62) ? "block" : rng.chance(0.6) ? "shop" : "civic";
  if (band === 2) return rng.chance(0.36) ? "garden" : rng.chance(0.55) ? "shop" : "block";
  return rng.chance(0.5) ? "garden" : rng.chance(0.6) ? "pavilion" : "shop";
}

/* -------------------------------------------------------------------------
 * Landmarks
 * ---------------------------------------------------------------------- */

export type LandmarkKind =
  | "beacon"
  | "observatory"
  | "market-hall"
  | "launch"
  | "tram"
  | "fountain"
  | "gate";

export interface Landmark {
  id: string;
  name: string;
  kind: LandmarkKind;
  /** World position of the thing itself, at deck height. */
  x: number;
  z: number;
  y: number;
  /** Which way its front faces, radians. */
  yaw: number;
  /** Footprint radius, so nothing else is placed inside it. */
  clear: number;
  /** Shown when you look at it, and on the map. */
  blurb: string;
}

/**
 * The half-dozen places worth walking to.
 *
 * Hand-placed, every one of them, and that is the point: procedural cities
 * fail at exactly this — they can make a thousand plausible buildings and not
 * one place you would agree to meet somebody. Each of these has a job. The
 * Beacon is visible from everywhere and orients you. The Observatory is the
 * reason to go to the rim. The Market Hall is where the crowd is. The Launch
 * Terrace is where the races start. The gates are how you get down to the
 * promenades without flying.
 */
export const LANDMARKS: Landmark[] = [
  {
    id: "beacon",
    name: "The Beacon",
    kind: "beacon",
    x: 0,
    z: 0,
    y: ISLAND_Y,
    yaw: 0,
    clear: 26,
    blurb: "Five hundred metres of lit glass. You can see it from the ice.",
  },
  {
    id: "observatory",
    name: "The Observatory",
    kind: "observatory",
    x: Math.cos(-Math.PI / 2) * 306,
    z: Math.sin(-Math.PI / 2) * 306,
    y: ISLAND_Y,
    yaw: -Math.PI / 2,
    clear: 30,
    blurb: "A telescope pointed off the edge, and a rail to lean on.",
  },
  {
    id: "market-hall",
    name: "The Market Hall",
    kind: "market-hall",
    x: Math.cos(Math.PI * 0.75) * 168,
    z: Math.sin(Math.PI * 0.75) * 168,
    y: ISLAND_Y,
    yaw: Math.PI * 0.75,
    clear: 34,
    blurb: "Iron and glass over four hundred stalls. Loud, warm, and open late.",
  },
  {
    id: "launch",
    name: "The Launch Terrace",
    kind: "launch",
    x: Math.cos(Math.PI * 0.25) * 300,
    z: Math.sin(Math.PI * 0.25) * 300,
    y: ISLAND_Y,
    yaw: Math.PI * 0.25,
    clear: 28,
    blurb: "Painted circles, a wind sock, and the start of every race.",
  },
  {
    id: "tram-halo",
    name: "Halo Station",
    kind: "tram",
    x: Math.cos(Math.PI) * 96,
    z: Math.sin(Math.PI) * 96,
    y: ISLAND_Y,
    yaw: Math.PI,
    clear: 16,
    blurb: "The ring tram, every ninety seconds, all the way round.",
  },
  {
    id: "fountain",
    name: "The Cistern",
    kind: "fountain",
    x: Math.cos(Math.PI * 0.5) * 44,
    z: Math.sin(Math.PI * 0.5) * 44,
    y: ISLAND_Y,
    yaw: Math.PI * 0.5,
    clear: 13,
    blurb: "All the island's water, on its way somewhere, briefly in the open.",
  },
];

/* -------------------------------------------------------------------------
 * Nav graph
 * ---------------------------------------------------------------------- */

export interface NavNode {
  id: number;
  x: number;
  z: number;
  y: number;
  /** Indices into the node array. Undirected; both directions are present. */
  links: number[];
  /** Rough width of the walkway here, for spreading a crowd out across it. */
  width: number;
}

/**
 * The pavement, as a graph.
 *
 * Nodes sit on the *sidewalk* rather than on the road centreline, on both
 * sides of every street, which is what lets a crowd look like a crowd instead
 * of like a queue down the middle of the carriageway. Crossings are explicit
 * links between the two sides at every junction, so a pedestrian who wants the
 * far pavement crosses at a corner like a person and not wherever they happen
 * to be standing.
 */
export function buildNav(): NavNode[] {
  const nodes: NavNode[] = [];
  const key = new Map<string, number>();

  const add = (x: number, z: number, width: number): number => {
    const k = `${Math.round(x)}:${Math.round(z)}`;
    const found = key.get(k);
    if (found !== undefined) return found;
    const id = nodes.length;
    nodes.push({ id, x, z, y: ISLAND_Y, links: [], width });
    key.set(k, id);
    return id;
  };
  const link = (a: number, b: number) => {
    if (a === b) return;
    if (!nodes[a].links.includes(b)) nodes[a].links.push(b);
    if (!nodes[b].links.includes(a)) nodes[b].links.push(a);
  };

  const radii = [HALO_R + 6, ...RING_R, RIM_R];

  /* ---- rings: a node every ~14 m on both pavements ---- */
  for (const rr of radii) {
    const isHalo = rr === HALO_R + 6;
    const off = isHalo ? 0 : W.ring.half + W.ring.walk * 0.5;
    for (const side of isHalo ? [0] : [-1, 1]) {
      const r = rr + off * side;
      const n = Math.max(16, Math.round((TAU * r) / 14));
      const ring: number[] = [];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU;
        ring.push(add(Math.cos(a) * r, Math.sin(a) * r, isHalo ? 12 : W.ring.walk));
      }
      for (let i = 0; i < n; i++) link(ring[i], ring[(i + 1) % n]);
    }
  }

  /* ---- avenues and lanes: both pavements, out from the Halo ---- */
  const spokes: Array<{ a: number; off: number; walk: number; r0: number }> = [];
  for (let i = 0; i < AVENUE_N; i++) {
    spokes.push({
      a: AVENUE_A0 + (i / AVENUE_N) * TAU,
      off: W.avenue.half + W.avenue.walk * 0.5,
      walk: W.avenue.walk,
      r0: HALO_R + 6,
    });
  }
  for (let i = 0; i < LANE_N; i++) {
    spokes.push({
      a: LANE_A0 + (i / LANE_N) * TAU,
      off: W.lane.half + W.lane.walk * 0.5,
      walk: W.lane.walk,
      r0: RING_R[0],
    });
  }

  for (const s of spokes) {
    for (const side of [-1, 1]) {
      // Offset perpendicular to the spoke, so the pavement is beside the road.
      const px = -Math.sin(s.a) * s.off * side;
      const pz = Math.cos(s.a) * s.off * side;
      const line: number[] = [];
      for (let r = s.r0; r <= RIM_R + 0.5; r += 14) {
        line.push(add(Math.cos(s.a) * r + px, Math.sin(s.a) * r + pz, s.walk));
      }
      for (let i = 0; i + 1 < line.length; i++) link(line[i], line[i + 1]);
    }
  }

  /* ---- crossings: stitch anything close that is not already linked ----
   * Cheap and complete. The alternative is enumerating every junction type by
   * hand, which is a list that goes stale the first time a width changes. */
  const CROSS = 26;
  const cell = new Map<string, number[]>();
  const ck = (x: number, z: number) => `${Math.floor(x / CROSS)}:${Math.floor(z / CROSS)}`;
  nodes.forEach((n) => {
    const k = ck(n.x, n.z);
    const list = cell.get(k);
    if (list) list.push(n.id);
    else cell.set(k, [n.id]);
  });
  for (const n of nodes) {
    const gx = Math.floor(n.x / CROSS);
    const gz = Math.floor(n.z / CROSS);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (const other of cell.get(`${gx + dx}:${gz + dz}`) ?? []) {
          if (other <= n.id) continue;
          const m = nodes[other];
          const d = Math.hypot(m.x - n.x, m.z - n.z);
          if (d > CROSS) continue;
          // Only cross where the midpoint is actually pavement or road — this
          // is what stops a "crossing" being cut straight through a building.
          const mid = surfaceAt((n.x + m.x) / 2, (n.z + m.z) / 2);
          if (mid.kind === "lot" || mid.kind === "void") continue;
          link(n.id, other);
        }
      }
    }
  }

  return nodes;
}

/* -------------------------------------------------------------------------
 * The plan
 * ---------------------------------------------------------------------- */

export interface CityPlan {
  blocks: Block[];
  lots: Lot[];
  landmarks: Landmark[];
  nav: NavNode[];
  /** Every shopfront door, for crowds and interiors. */
  doors: Array<{ lot: string; x: number; z: number; nx: number; nz: number }>;
}

/**
 * How many radians of clearance a radial street needs at radius `r`.
 *
 * Inside the first ring the only radials are avenues; outside it the lanes
 * bisect them and a block's sides are lane-width, not avenue-width.
 */
function clearFor(band: number, r: number): number {
  const metres =
    band === 0 ? W.avenue.half + W.avenue.walk + 1 : W.lane.half + W.lane.walk + 1;
  return metres / Math.max(r, 1);
}

export function buildCityPlan(): CityPlan {
  const rng = makeRng("empyrean-city-v2");
  const blocks: Block[] = [];
  const lots: Lot[] = [];

  const bands = RING_R.length + 1; // 4 bands: inside ring0 … outside ring2

  for (let band = 0; band < bands; band++) {
    const { r0, r1 } = bandBounds(band);
    if (r1 - r0 < 10) continue;

    // Inside the first ring only the eight avenues divide the ring; outside it
    // the lanes bisect them, which is what keeps the outer blocks from being
    // two hundred metres of frontage with one door on it.
    const sectors = band === 0 ? AVENUE_N : AVENUE_N * 2;
    const step = TAU / sectors;
    // Half a road plus its pavement, as an angle, at each end of the band.
    const clearIn = clearFor(band, r0);
    const clearOut = clearFor(band, r1);

    for (let s = 0; s < sectors; s++) {
      const base0 = AVENUE_A0 + s * step;
      const base1 = AVENUE_A0 + (s + 1) * step;
      if (base1 - base0 <= clearIn * 2) continue;

      const district = districtAt((r0 + r1) / 2).id;
      const block: Block = { id: `b${band}-${s}`, district, band, lots: [] };

      /* Subdivide. Angularly always; radially when the band is deep enough
         to hold two buildings back to back with a service gap between them. */
      const arcOuter = (base1 - base0 - clearOut * 2) * r1;
      const nA = Math.max(1, Math.min(4, Math.round(arcOuter / (band === 0 ? 40 : 34))));
      const depth = r1 - r0;
      const nR = depth > 50 ? 2 : 1;

      for (let ia = 0; ia < nA; ia++) {
        for (let ir = 0; ir < nR; ir++) {
          const lr0 = r0 + ((r1 - r0) * ir) / nR;
          const lr1 = r0 + ((r1 - r0) * (ir + 1)) / nR;
          // Angular clearance, evaluated at each of the lot's own two radii.
          const cIn = clearFor(band, lr0);
          const cOut = clearFor(band, lr1);
          const f0 = ia / nA;
          const f1 = (ia + 1) / nA;
          const gap = nA > 1 ? 1.8 : 0;
          const spanI = base1 - base0 - cIn * 2;
          const spanO = base1 - base0 - cOut * 2;
          const a0i = base0 + cIn + spanI * f0 + gap / Math.max(lr0, 1);
          const a1i = base0 + cIn + spanI * f1 - gap / Math.max(lr0, 1);
          const a0o = base0 + cOut + spanO * f0 + gap / Math.max(lr1, 1);
          const a1o = base0 + cOut + spanO * f1 - gap / Math.max(lr1, 1);
          // Radial inset: half the service gap at each end, none at the band
          // edges — the band is already clear of the ring roads.
          const rGap = nR > 1 ? 3.2 : 0;
          const ir0 = lr0 + (ir > 0 ? rGap : 0.8);
          const ir1 = lr1 - (ir < nR - 1 ? rGap : 0.8);
          if (ir1 - ir0 < 7 || a1i <= a0i || a1o <= a0o) continue;

          const poly = trapezoidPoly(ir0, ir1, a0i, a1i, a0o, a1o);
          const centroid = centroidOf(poly);
          const r = Math.hypot(centroid.x, centroid.z);
          const a = Math.atan2(centroid.z, centroid.x);
          const front = chooseFront(poly, centroid);
          // A lot with no street on any side is a courtyard, not a building.
          if (front.score < 0) continue;

          const use = useFor(band, rng);
          const seed = rng.next();
          const lot: Lot = {
            id: `${block.id}-${ia}${ir}`,
            district,
            poly,
            centroid,
            r,
            a,
            y: ISLAND_Y,
            height: heightFor(r, a, use, rng),
            use,
            frontEdge: front.edge,
            frontNormal: front.normal,
            frontMid: front.mid,
            frontLen: front.len,
            door: front.door,
            seed,
          };
          block.lots.push(lot);
          lots.push(lot);
        }
      }

      if (block.lots.length) blocks.push(block);
    }
  }

  /* ---- landmarks win every argument ---- */
  const kept: Lot[] = [];
  for (const lot of lots) {
    const hit = LANDMARKS.find(
      (l) => Math.hypot(l.x - lot.centroid.x, l.z - lot.centroid.z) < l.clear + 12,
    );
    if (hit) continue;
    kept.push(lot);
  }
  for (const b of blocks) b.lots = b.lots.filter((l) => kept.includes(l));

  const doors = kept
    .filter((l) => l.use !== "garden")
    .map((l) => ({
      lot: l.id,
      x: l.door.x,
      z: l.door.z,
      nx: l.frontNormal.x,
      nz: l.frontNormal.z,
    }));

  return {
    blocks: blocks.filter((b) => b.lots.length > 0),
    lots: kept,
    landmarks: LANDMARKS,
    nav: buildNav(),
    doors,
  };
}

/**
 * The plan, built once.
 *
 * Deterministic and pure, so building it twice would give the same answer and
 * cost the same again; every module imports this rather than calling
 * `buildCityPlan` itself.
 */
let cached: CityPlan | null = null;
export function cityPlan(): CityPlan {
  if (!cached) cached = buildCityPlan();
  return cached;
}
